# helper/net.py: Pinned HTTP(S) connections, probe URL policy, public probes and health checks.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    VERSION, diagnostic, inspect)
# Mutable state lives in common and is never copied by import: PROBE_POLICY_FALLBACKS
# </build:header>
def pinned_socket(addresses,port,timeout):
    """Connects only to addresses validated earlier, so a second DNS answer cannot redirect the probe."""
    error=OSError('No validated probe address')
    for address in addresses:
        try:return socket.create_connection((address,port),timeout)
        except OSError as failure:error=failure
    raise error
class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self,host,port,addresses,**kw):super().__init__(host,port,**kw);self.addresses=addresses
    def connect(self):self.sock=pinned_socket(self.addresses,self.port,self.timeout)
class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self,host,port,addresses,**kw):super().__init__(host,port,**kw);self.addresses=addresses
    def connect(self):
        sock=pinned_socket(self.addresses,self.port,self.timeout)
        try:self.sock=self._context.wrap_socket(sock,server_hostname=self.host)
        except Exception:sock.close();raise
class OriginHTTPSConnection(PinnedHTTPSConnection):
    def __init__(self,host,port,**kw):super().__init__(host,port,['127.0.0.1'],**kw)

PROBE_LIMIT=256*1024
METADATA_ADDRESSES={ipaddress.ip_address(a) for a in ['169.254.169.254','169.254.170.2','fd00:ec2::254','100.100.100.200']}
THIS_NETWORK=ipaddress.ip_network('0.0.0.0/8')
# Decided explicitly rather than through is_global, whose IPv6 tables differ between Python releases.
NAT64=ipaddress.ip_network('64:ff9b::/96')
REFUSED_IPV6=[ipaddress.ip_network(n) for n in ['::/96','64:ff9b:1::/48','2001::/32','2001:db8::/32','100::/64']]
def embedded_ipv4(address):
    """IPv4 carried inside a 6to4 or NAT64 address; the probe would effectively reach it."""
    if address.version!=6:return None
    return address.sixtofour or (ipaddress.IPv4Address(int(address)&0xffffffff) if address in NAT64 else None)
class ProbePolicyError(ValueError):
    """A probe target the address policy refuses. Unlike a network failure, retrying cannot fix it."""
def local_address(address):
    """True when the source host owns this address (bind succeeds only for local interfaces)."""
    try:
        with socket.socket(socket.AF_INET6 if address.version==6 else socket.AF_INET,socket.SOCK_STREAM) as probe:probe.bind((str(address),0))
        return True
    except OSError:return False
def probe_addresses(hostname,port,domains=()):
    """Resolve on the source host and return the addresses to pin, refusing internal targets.
    Loopback and public addresses are allowed. Private, CGNAT and ULA addresses are allowed only
    for a configured site domain name that resolves to an address of this host. Link-local, cloud
    metadata, multicast, unspecified and reserved addresses are always refused. Every answer must pass."""
    host=hostname.lower().rstrip('.')
    try:literal=ipaddress.ip_address(host)
    except ValueError:literal=None
    try:answers=[literal] if literal else [ipaddress.ip_address(info[4][0].split('%')[0]) for info in socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)]
    except (OSError,UnicodeError):raise ValueError('Probe host could not be resolved from the source server')
    configured=not literal and host in {str(d).lower().rstrip('.') for d in domains or ()}
    chosen=[]
    for address in answers:
        address=getattr(address,'ipv4_mapped',None) or address
        if not address.is_loopback: # ::1 sits inside the reserved ::/8 block.
            embedded=embedded_ipv4(address)
            if address.version==6 and any(address in network for network in REFUSED_IPV6):raise ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
            if embedded is not None:
                # Only a public IPv4 may be reached through 6to4 or NAT64; loopback and private never apply.
                if embedded in METADATA_ADDRESSES or not embedded.is_global or embedded in THIS_NETWORK:raise ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
                if str(address) not in chosen:chosen.append(str(address))
                continue
            if address in METADATA_ADDRESSES or address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved or getattr(address,'is_site_local',False) or (address.version==4 and address in THIS_NETWORK):raise ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
            if not address.is_global and not (configured and local_address(address)):raise ProbePolicyError('the URL resolves to a private address that does not belong to this server; use the site domain, a loopback port or a public address')
        if str(address) not in chosen:chosen.append(str(address))
    if not chosen:raise ValueError('Probe host could not be resolved from the source server')
    return chosen
def fetch(url,timeout,domains=(),redirects=5):
    """GET with every hop resolved, validated and pinned. Redirects are followed only to the same
    host or to another configured site domain, keeping the scheme (or upgrading HTTP to HTTPS) and the
    port (or moving to the default port on an upgrade or for a configured domain); otherwise the redirect
    response itself is returned. Only the stored URL can raise ProbePolicyError: a refused redirect target
    returns the redirect, which callers treat as a failed probe, so a site cannot turn its own probe into
    a policy skip. timeout is a total budget for the whole probe: every connect attempt, redirect and body read."""
    allowed={str(d).lower().rstrip('.') for d in domains or ()};origin=None;previous=None;deadline=time.monotonic()+timeout
    for _ in range(redirects+1):
        parsed=urllib.parse.urlsplit(url)
        try:
            if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ProbePolicyError('use an HTTP(S) URL without login details')
            host=parsed.hostname.lower().rstrip('.');origin=origin or host
            port=parsed.port or (443 if parsed.scheme=='https' else 80)
            if previous:
                scheme,last_port=previous;upgrade=scheme=='http' and parsed.scheme=='https';default=port==(443 if parsed.scheme=='https' else 80)
                if host!=origin and host not in allowed:return status,body
                if parsed.scheme!=scheme and not upgrade:return status,body
                if not ((parsed.scheme==scheme and port==last_port) or (default and (upgrade or host in allowed))):return status,body
            addresses=probe_addresses(host,port,domains)
        except ProbePolicyError:
            if previous is None:raise
            return status,body
        except ValueError:
            if previous is None:raise
            return status,body
        previous=(parsed.scheme,port)
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('Probe exceeded its total time limit')
        if parsed.scheme=='https':connection=PinnedHTTPSConnection(parsed.hostname,port,addresses,timeout=remaining,context=ssl.create_default_context())
        else:connection=PinnedHTTPConnection(parsed.hostname,port,addresses,timeout=remaining)
        try:status,body,location=exchange(connection,urllib.parse.urlunsplit(('','',parsed.path or '/',parsed.query,'')),{'Cache-Control':'no-cache','User-Agent':'DockNest-helper/%d'%VERSION,'Accept':'*/*'},deadline)
        finally:connection.close()
        if status not in (301,302,303,307,308) or not location:return status,body
        url=urllib.parse.urljoin(url,location)
    return status,body

def exchange(connection,path,headers,deadline):
    """One request/response under an absolute deadline. Socket timeouts only bound each read, so a server
    dripping one byte per second would otherwise hold a probe (and the restart or recovery loop) for hours.
    On expiry the socket is shut down to unblock the worker and the probe counts as failed, not refused."""
    result={}
    def work():
        try:
            connection.request('GET',path,headers=headers)
            response=connection.getresponse();result['value']=(response.status,response.read(PROBE_LIMIT),response.getheader('Location'))
        except BaseException as error:result['error']=error
    worker=threading.Thread(target=work,daemon=True);worker.start();worker.join(max(0,deadline-time.monotonic()))
    if worker.is_alive():
        try:
            if connection.sock:connection.sock.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        connection.close();raise TimeoutError('Probe exceeded its total time limit')
    if 'error' in result:raise result['error']
    return result['value']

PROBE_LABELS={'health':'maintenance health URL','public':'public maintenance URL'}
def probe_policy_preflight(cfg):
    """Returns {probe: reason} for stored probe URLs the policy refuses, before anything on the host
    changes. Only DNS is queried; no HTTP request is sent. A name that does not resolve is not a policy
    decision and is left to the probe itself, as before the policy existed."""
    m=cfg.get('maintenance') or {};refused={}
    targets=[('health',m.get('healthUrl'))]
    # Same rule as src/probe-url.js: the public probe runs only when maintenance is explicitly required.
    if m.get('required') is True and not m.get('probeOrigin'):targets.append(('public',m.get('publicUrl')))
    for probe,url in targets:
        if not url:continue
        parsed=urllib.parse.urlsplit(url)
        try:
            if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ProbePolicyError('use an HTTP(S) URL without login details')
            probe_addresses(parsed.hostname,parsed.port or (443 if parsed.scheme=='https' else 80),cfg.get('domains',()))
        except ProbePolicyError as error:refused[probe]=str(error)
        except ValueError:pass
    return refused
def skip_refused_probes(cfg):
    """Upgrade safety: a site saved before the policy keeps getting backups. Refused probes are disabled
    for every phase (capture, watchdog, boot recovery via the journaled cfg) and never contacted; health
    then relies on container state and Docker health checks, as for sites without a health URL.
    The underscore key stays out of the plan fingerprint."""
    refused=probe_policy_preflight(cfg)
    cfg['_skippedProbes']=sorted(set(cfg.get('_skippedProbes',[]))|set(refused))
    for probe in refused:policy_fallback(probe)
    return refused
def probe_url(cfg,probe):
    if probe in cfg.get('_skippedProbes',()):return None
    return (cfg.get('maintenance') or {}).get('healthUrl' if probe=='health' else 'publicUrl')
def policy_fallback(probe):
    # Recorded so the job result can say the probe was skipped rather than passed.
    PROBE_POLICY_FALLBACKS.append(probe);diagnostic(phase='probe-policy-fallback',probe=probe)

def public_probe(m,domains=()):
    url=m.get('publicUrl','')
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ProbePolicyError('use an HTTP(S) URL without login details')
    if not m.get('probeOrigin'):return fetch(url,10,domains)
    # Same hostname and verified TLS identity; only the connection address changes to loopback.
    if parsed.scheme=='https':connection=OriginHTTPSConnection(parsed.hostname,parsed.port or 443,timeout=10,context=ssl.create_default_context())
    else:connection=http.client.HTTPConnection('127.0.0.1',parsed.port or 80,timeout=10)
    try:
        path=urllib.parse.urlunsplit(('','',parsed.path or '/',parsed.query,''))
        return exchange(connection,path,{'Host':parsed.netloc,'Cache-Control':'no-cache'},time.monotonic()+10)[:2]
    finally:connection.close()

def health(containers,url=None,domains=(),fallback=False):
    """A policy-refused URL raises unless fallback is set; recovery paths then rely on container
    health only (the same check used when no health URL is configured) instead of waiting forever."""
    for c in inspect(containers) if containers else []:
        if not c['State']['Running']: return False
        if c['State'].get('Health',{}).get('Status','healthy')!='healthy': return False
    if url:
        try:
            status,body=fetch(url,5,domains)
            if status!=200 or b'dbm-maintenance-v1' in body:return False
        except ProbePolicyError:
            if not fallback:raise
            policy_fallback('health')
        except Exception:return False
    return True

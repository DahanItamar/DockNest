"""Certificate facts for certificate alerts (docs/alerts.md, "Certificates"). Run: python3 remote/test_certificates.py
Proves the helper reads only public certificate files and certbot's renewal outcome, sends only dates, DNS names,
serials and certificate names, and never lets a certificate problem fail the operation it rides on."""
import unittest, tempfile, pathlib, shutil, sys, ssl, time, os
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

# A self-signed public test certificate (no key exists anywhere): *.example.test and example.test, serial 1A2B3C,
# valid until 2126. Written to a temporary file because the repository ignores .pem files.
CERTIFICATE='''-----BEGIN CERTIFICATE-----
MIIBnjCCAUOgAwIBAgIDGis8MAoGCCqGSM49BAMCMBcxFTATBgNVBAMMDGV4YW1w
bGUudGVzdDAgFw0yNjExMDIxMDM0MjhaGA8yMTI2MTAwOTEwMzQyOFowFzEVMBMG
A1UEAwwMZXhhbXBsZS50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgsol
c6NLx/iZZbDoEcGv1h/wfCmkzwKa061ngyb6O0A19zGNu4fX73Djqopt+4deqUKi
ZumR4zgYAh8LdvbF+6N8MHowHQYDVR0OBBYEFHgAm8UH/Zmq/R6eKD4V1XhVd0Vu
MB8GA1UdIwQYMBaAFHgAm8UH/Zmq/R6eKD4V1XhVd0VuMA8GA1UdEwEB/wQFMAMB
Af8wJwYDVR0RBCAwHoIOKi5leGFtcGxlLnRlc3SCDGV4YW1wbGUudGVzdDAKBggq
hkjOPQQDAgNJADBGAiEAkqZ6YwgX2bgQX2qZ4VWkGwJADcb1PIJ+cUf4vTC08LEC
IQDfGNXmJyIbmsktrC2HtWPoJWlndihhBO+ohCgJR7bLbA==
-----END CERTIFICATE-----
'''
_fixture=tempfile.TemporaryDirectory()
FIXTURE=pathlib.Path(_fixture.name)/'cert.pem';FIXTURE.write_text(CERTIFICATE)

class Letsencrypt:
    """A fake /etc/letsencrypt and /var/log/letsencrypt in a temporary folder."""
    def __init__(self):
        self.directory=tempfile.TemporaryDirectory();base=pathlib.Path(self.directory.name)
        self.root=base/'etc';self.logs=base/'log';(self.root/'live').mkdir(parents=True);(self.root/'renewal').mkdir();self.logs.mkdir()
    def lineage(self,name,renews=True,cert=FIXTURE):
        folder=self.root/'live'/name;folder.mkdir()
        shutil.copy(cert,folder/'cert.pem')
        (folder/'privkey.pem').write_text('KEY-MATERIAL-MUST-NEVER-LEAVE\n')
        if renews:(self.root/'renewal'/(name+'.conf')).write_text('[renewalparams]\n')
    def log(self,text,index=0):(self.logs/('letsencrypt.log'+('.%d'%index if index else ''))).write_text(text)
    def facts(self):return helper.certbot_certificates(self.root,self.logs)
    def close(self):self.directory.cleanup()

class CertbotCertificates(unittest.TestCase):
    def setUp(self):self.le=Letsencrypt()
    def tearDown(self):self.le.close()
    def test_reads_dates_names_and_serial_of_a_wildcard_certificate_and_nothing_else(self):
        self.le.lineage('example.test')
        [fact]=self.le.facts()
        self.assertEqual(fact['source'],'certbot');self.assertEqual(fact['name'],'example.test')
        self.assertEqual(fact['domains'],['*.example.test','example.test']);self.assertEqual(fact['serial'],'1A2B3C')
        self.assertGreater(fact['notAfter'],time.time()+50*365*86400);self.assertTrue(fact['renews'])
        self.assertEqual(set(fact),{'source','name','notAfter','domains','serial','renews'})
        self.assertNotIn('KEY-MATERIAL',repr(fact))
    def test_no_certbot_means_no_facts_and_no_error(self):
        self.assertEqual(helper.certbot_certificates(pathlib.Path(self.le.directory.name)/'missing',self.le.logs),[])
    def test_unreadable_oversized_or_oddly_named_certificates_are_skipped(self):
        self.le.lineage('good.test')
        bad=self.le.root/'live'/'broken.test';bad.mkdir();(bad/'cert.pem').write_text('not a certificate')
        big=self.le.root/'live'/'big.test';big.mkdir();(big/'cert.pem').write_bytes(b'x'*70000)
        (self.le.root/'live'/'.hidden').mkdir()
        self.assertEqual([fact['name'] for fact in self.le.facts()],['good.test'])
    def test_a_certificate_without_renewal_settings_is_reported_as_not_renewing(self):
        self.le.lineage('manual.test',renews=False)
        self.assertFalse(self.le.facts()[0]['renews'])
    def test_a_python_without_the_certificate_decoder_degrades_to_no_facts(self):
        self.le.lineage('example.test')
        import types
        with patch.object(helper.ssl,'_ssl',types.SimpleNamespace()):self.assertEqual(self.le.facts(),[])
        self.assertEqual(len(self.le.facts()),1)

class RenewalOutcome(unittest.TestCase):
    def setUp(self):self.le=Letsencrypt();self.le.lineage('example.test');self.le.lineage('other.test')
    def tearDown(self):self.le.close()
    def outcome(self):return {fact['name']:fact.get('renewal') for fact in self.le.facts()}
    def test_a_failed_renewal_is_reported_without_any_log_text(self):
        self.le.log('2026-11-01 03:00:01,000:ERROR:certbot._internal.renewal:Failed to renew certificate example.test with error: secret-ish detail\n'
            'All renewals failed. The following certificates could not be renewed:\n  /etc/letsencrypt/live/example.test/fullchain.pem (failure)\n')
        self.assertEqual(self.outcome(),{'example.test':'failed','other.test':None})
        self.assertNotIn('secret-ish',repr(self.le.facts()))
    def test_a_failure_carries_the_time_of_its_run_so_a_later_failure_is_new(self):
        self.le.log('Failed to renew certificate example.test with error: dns\n')
        os.utime(self.le.logs/'letsencrypt.log',(4000000000,4000000000))
        first={fact['name']:fact for fact in self.le.facts()}
        self.assertEqual(first['example.test']['renewalAt'],4000000000);self.assertNotIn('renewalAt',first['other.test'])
        os.utime(self.le.logs/'letsencrypt.log',(4000043200,4000043200))
        self.assertEqual({fact['name']:fact for fact in self.le.facts()}['example.test']['renewalAt'],4000043200)
        self.le.log('/etc/letsencrypt/live/example.test/fullchain.pem (success)\n')
        self.assertNotIn('renewalAt',{fact['name']:fact for fact in self.le.facts()}['example.test'],'only a failure has a run time')
    def test_failed_then_succeeded_in_a_newer_run_is_ok(self):
        self.le.log('Failed to renew certificate example.test with error: timeout\n',index=1)
        self.le.log('Congratulations, all renewals succeeded:\n  /etc/letsencrypt/live/example.test/fullchain.pem (success)\n')
        self.assertEqual(self.outcome()['example.test'],'ok')
    def test_later_lines_of_one_run_win(self):
        self.le.log('/etc/letsencrypt/live/example.test/fullchain.pem (success)\nFailed to renew certificate example.test with error: rate limited\n')
        self.assertEqual(self.outcome()['example.test'],'failed')
    def test_a_newest_run_that_renewed_nothing_keeps_the_last_real_outcome(self):
        self.le.log('Failed to renew certificate example.test with error: dns\n',index=1)
        self.le.log('Processing /etc/letsencrypt/renewal/example.test.conf\nCertificate not yet due for renewal\nNo renewals were attempted.\n')
        self.assertEqual(self.outcome()['example.test'],'failed')
    def test_a_failure_logged_before_the_current_certificate_was_issued_is_over(self):
        self.le.log('Failed to renew certificate example.test with error: dns\n')
        os.utime(self.le.logs/'letsencrypt.log',(1700000000,1700000000))  # 2023, before the fixture's notBefore
        self.assertEqual(self.outcome()['example.test'],'ok')
    def test_only_the_tail_of_a_huge_log_is_read(self):
        self.le.log('Failed to renew certificate example.test with error: old\n'+'x'*(helper.CERT_LOG_TAIL+10)+'\n')
        self.assertIsNone(self.outcome()['example.test'])

class ProbeCertificates(unittest.TestCase):
    def setUp(self):helper.PEER_CERTIFICATES.clear()
    def tearDown(self):helper.PEER_CERTIFICATES.clear()
    class Socket:
        def __init__(self,cert):self.cert=cert
        def getpeercert(self):return self.cert
    def test_a_verified_handshake_records_the_dates_the_visitor_sees(self):
        cert=ssl._ssl._test_decode_cert(str(FIXTURE))
        helper.note_peer_certificate('Shop.Example.Test.',self.Socket(cert))
        fact=helper.PEER_CERTIFICATES['shop.example.test']
        self.assertEqual((fact['source'],fact['name'],fact['serial']),('tls','shop.example.test','1A2B3C'))
        self.assertEqual(fact['notAfter'],int(ssl.cert_time_to_seconds(cert['notAfter'])))
    def test_an_expired_certificate_is_recorded_from_the_refused_handshake(self):
        error=ssl.SSLCertVerificationError('certificate verify failed: certificate has expired');error.verify_code=10
        helper.note_peer_certificate('old.example.test',error=error)
        self.assertEqual(helper.PEER_CERTIFICATES['old.example.test'],{'source':'tls','name':'old.example.test','expired':True})
    def test_an_expired_marker_never_replaces_a_certificate_verified_for_the_same_host(self):
        cert=ssl._ssl._test_decode_cert(str(FIXTURE))
        helper.note_peer_certificate('shop.example.test',self.Socket(cert))  # the public probe verified it
        error=ssl.SSLCertVerificationError('certificate has expired');error.verify_code=10
        helper.note_peer_certificate('shop.example.test',error=error)  # the origin probe reached an old one on loopback
        self.assertEqual(helper.PEER_CERTIFICATES['shop.example.test']['serial'],'1A2B3C')
        self.assertNotIn('expired',helper.PEER_CERTIFICATES['shop.example.test'])
        # A verified certificate does replace an earlier expired marker.
        helper.note_peer_certificate('next.example.test',error=error);helper.note_peer_certificate('next.example.test',self.Socket(cert))
        self.assertNotIn('expired',helper.PEER_CERTIFICATES['next.example.test'])
    def test_other_handshake_failures_and_plain_http_record_nothing(self):
        error=ssl.SSLCertVerificationError('self signed');error.verify_code=18
        helper.note_peer_certificate('self.example.test',error=error)
        helper.note_peer_certificate('reset.example.test',error=ConnectionResetError())
        helper.note_peer_certificate('weird.example.test',self.Socket(None))
        self.assertEqual(helper.PEER_CERTIFICATES,{})
    def test_the_pinned_https_connection_reports_its_handshake(self):
        cert=ssl._ssl._test_decode_cert(str(FIXTURE))
        class Context:
            def wrap_socket(self,sock,server_hostname):return ProbeCertificates.Socket(cert)
        class Raw:
            def close(self):pass
        connection=helper.PinnedHTTPSConnection('site.example.test',443,['203.0.113.9'],timeout=1,context=ssl.create_default_context())
        connection._context=Context()
        with patch('helper.pinned_socket',return_value=Raw()):connection.connect()
        self.assertIn('site.example.test',helper.PEER_CERTIFICATES)
    def test_facts_never_fail_the_operation(self):
        helper.PEER_CERTIFICATES['a.example.test']={'source':'tls','name':'a.example.test','expired':True}
        with patch('helper.certbot_certificates',side_effect=RuntimeError('boom')):self.assertEqual(helper.certificate_facts(),[])
        with patch('helper.certbot_certificates',return_value=[]):self.assertEqual(helper.certificate_facts(),[{'source':'tls','name':'a.example.test','expired':True}])

if __name__=='__main__':unittest.main()

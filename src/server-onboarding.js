import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
const { utils } = ssh2;

export const serverReportCommand = `python3 - <<'PY'
import base64, hashlib, json, pathlib, socket, os, shutil
keys=[]
for name in ['ssh_host_ed25519_key.pub','ssh_host_ecdsa_key.pub','ssh_host_rsa_key.pub']:
    p=pathlib.Path('/etc/ssh')/name
    if p.exists():
        parts=p.read_text().split()
        keys.append({'algorithm':parts[0],'fingerprint':hashlib.sha256(base64.b64decode(parts[1])).hexdigest()})
print(json.dumps({'version':1,'hostname':socket.gethostname(),'username':__import__('pwd').getpwuid(os.geteuid()).pw_name,'uid':os.geteuid(),'hostKeys':keys,'python':True,'dockerInstalled':bool(shutil.which('docker'))}))
PY`;

export async function prepareServerKey() {
 const {privateKey}=await promisify(generateKeyPair)('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs1',format:'pem'}});
 const parsed=utils.parseKey(privateKey);
 if(parsed instanceof Error)throw parsed;
 const publicKey=`ssh-rsa ${parsed.getPublicSSH().toString('base64')} docknest`;
 const installCommand=String.raw`set -eu
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 700 "$HOME/.ssh"
chmod 600 "$HOME/.ssh/authorized_keys"
grep -qxF '${publicKey}' "$HOME/.ssh/authorized_keys" || printf '%s\n' '${publicKey}' >> "$HOME/.ssh/authorized_keys"
${serverReportCommand}`;
 return {privateKey,publicKey,installCommand};
}

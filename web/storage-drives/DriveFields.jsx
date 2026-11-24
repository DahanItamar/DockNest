import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { IconCopy, IconCheck, IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import { AlertPanel } from '../system.jsx';
import { OAuthSignIn } from './OAuthSignIn.jsx';
import { COMPOSE_SNIPPET, LOCAL_DOCS, folderIssue, isOauthKind, labelOf, smbHostIssue, smbShareIssue, webdavIssue } from './drive-model.js';

const PATH = '/storage-targets/rclone';
const drivePhrase = { personal: 'Personal', business: 'Work or school', documentLibrary: 'SharePoint library' };
// A sentence from the page itself (not from the API), so the parent shows it in the form error panel.
const refuse = (message, field) => Object.assign(new Error(message), { handled: true, field });

// Fields of one cloud drive, network share or local folder inside Connect storage. The parent owns the form, the name and the
// Test & connect button; `build(name)` checks the fields, finishes the sign-in when there is one and resolves with the
// request to send ({path, body}). `Field` is the app's labelled input.
export const DriveFields = forwardRef(function DriveFields({ api, kind, guard, Field, disabled, onReady }, ref) {
  const [folder, setFolder] = useState('docknest');
  const [web, setWeb] = useState({ endpoint: '', vendor: 'nextcloud', username: '', password: '' });
  const [smb, setSmb] = useState({ host: '', share: '', port: '', domain: '', username: '', password: '' });
  const [local, setLocal] = useState({ path: '', same: false, sameDisk: false });
  const [drives, setDrives] = useState(null), [driveId, setDriveId] = useState(''), [errors, setErrors] = useState({}), [copied, setCopied] = useState(false);
  const oauth = useRef(null);
  // A local folder cannot be tested without a path, so Test & connect waits for one.
  useEffect(() => { onReady?.(kind === 'local' ? Boolean(local.path.trim()) : true); }, [kind, local.path]);
  const oauthKind = isOauthKind(kind);
  const mark = (field, message) => setErrors(message ? { [field]: message } : {});

  useImperativeHandle(ref, () => ({
    async build(name) {
      setErrors({});
      const root = folder.trim(), rootIssue = folderIssue(root);
      if (rootIssue) { mark('folder', rootIssue); throw refuse(rootIssue, 'folder'); }
      const common = { name, root };
      if (oauthKind) {
        const session = await oauth.current.complete();
        if (kind !== 'onedrive') return { path: PATH + '/connect', body: { backend: kind, sessionId: session.sessionId, ...common } };
        // OneDrive has personal, work and library drives: use the only one, or ask which.
        let list = drives;
        if (!list) {
          try { list = (await api(`${PATH}/authorize/${encodeURIComponent(session.sessionId)}/drives`)).drives || []; } catch (e) { throw Object.assign(e, { handled: false }); }
          setDrives(list); if (list.length === 1) setDriveId(list[0].id);
        }
        const chosen = list.length === 1 ? list[0] : list.find(item => item.id === driveId);
        if (!list.length) throw refuse('No OneDrive was found for this account. Sign in with another account.');
        if (!chosen) throw refuse('Choose which OneDrive to use, then press Test & connect again.', 'drive');
        return { path: PATH + '/connect', body: { backend: 'onedrive', sessionId: session.sessionId, driveId: chosen.id, driveType: chosen.type, ...common } };
      }
      if (kind === 'webdav') {
        const issue = webdavIssue(web.endpoint);
        if (issue) { mark('endpoint', issue); throw refuse(issue, 'endpoint'); }
        if (!web.username || !web.password) { const text = 'Enter the user name and password.'; mark('username', text); throw refuse(text, 'username'); }
        return { path: PATH + '/connect', body: { backend: 'webdav', endpoint: web.endpoint.trim(), vendor: web.vendor, username: web.username, password: web.password, ...common } };
      }
      if (kind === 'smb') {
        const issue = smbHostIssue(smb.host) || smbShareIssue(smb.share);
        if (issue) { const field = smbHostIssue(smb.host) ? 'host' : 'share'; mark(field, issue); throw refuse(issue, field); }
        if (!smb.username || !smb.password) { const text = 'Enter the user name and password.'; mark('username', text); throw refuse(text, 'username'); }
        const port = Number(smb.port);
        return { path: PATH + '/connect', body: { backend: 'smb', host: smb.host.trim(), share: smb.share.trim(), ...(Number.isInteger(port) && port > 0 ? { port } : {}), ...(smb.domain.trim() ? { domain: smb.domain.trim() } : {}), username: smb.username, password: smb.password, ...common } };
      }
      if (!local.path.trim()) { mark('path', 'Enter the folder path inside DockNest, for example /backups/usb.'); throw refuse('Enter the folder path inside DockNest, for example /backups/usb.', 'path'); }
      return { path: PATH.replace('/rclone', '') + '/local/connect', body: { name, path: local.path.trim(), root, acceptSameDisk: local.same } };
    },
    // Called by the parent when the API says the folder shares a disk with DockNest.
    sameDisk() { setLocal(previous => ({ ...previous, sameDisk: true })); },
    ready: () => (kind === 'local' ? Boolean(local.path.trim()) : true),
  }), [api, kind, folder, web, smb, local, drives, driveId]);

  async function copy() { try { await navigator.clipboard.writeText(COMPOSE_SNIPPET); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the snippet is selectable text */ } }
  const folderField = <Field label={kind === 'local' ? 'Subfolder for backups' : kind === 'smb' ? 'Folder in the share' : kind === 'webdav' ? 'Folder on the server' : 'Folder in the drive'} name="driveFolder" value={folder} onChange={e => { setFolder(e.target.value); setErrors({}); }} maxLength={200} autoComplete="off" spellCheck={false} error={errors.folder} help="DockNest keeps its backups in this folder. It is created if it is missing." />;

  return <div className="dr-fields">
    {oauthKind && <OAuthSignIn ref={oauth} key={kind} api={api} backend={kind} guard={guard} disabled={disabled} />}
    {kind === 'onedrive' && drives && drives.length > 1 && <Field label="Which OneDrive" value={driveId} onChange={e => { setDriveId(e.target.value); setErrors({}); }} error={errors.drive}
      options={[['', 'Choose one'], ...drives.map(item => [item.id, `${item.name} (${drivePhrase[item.type] || item.type})`])]} />}
    {kind === 'webdav' && <>
      <Field label="WebDAV address" type="url" value={web.endpoint} onChange={e => { setWeb({ ...web, endpoint: e.target.value }); setErrors({}); }} placeholder="https://cloud.example.com/remote.php/dav/files/user" autoComplete="off" spellCheck={false} error={errors.endpoint} help="An HTTPS address without a user name or password in it." />
      <Field label="Server type" value={web.vendor} onChange={e => setWeb({ ...web, vendor: e.target.value })} options={[['nextcloud', 'Nextcloud'], ['owncloud', 'ownCloud'], ['other', 'Other WebDAV server']]} />
      <div className="form-grid"><Field label="User name" value={web.username} onChange={e => { setWeb({ ...web, username: e.target.value }); setErrors({}); }} autoComplete="off" error={errors.username} /><Field label="Password" type="password" value={web.password} onChange={e => setWeb({ ...web, password: e.target.value })} autoComplete="new-password" help="Use an app password if the server offers one. DockNest encrypts it and never shows it again." /></div>
    </>}
    {kind === 'smb' && <>
      <div className="form-grid"><Field label="File server" value={smb.host} onChange={e => { setSmb({ ...smb, host: e.target.value }); setErrors({}); }} placeholder="nas.example.com" autoComplete="off" spellCheck={false} error={errors.host} /><Field label="Share name" value={smb.share} onChange={e => { setSmb({ ...smb, share: e.target.value }); setErrors({}); }} placeholder="backups" autoComplete="off" spellCheck={false} error={errors.share} /></div>
      <div className="form-grid"><Field label="User name" value={smb.username} onChange={e => { setSmb({ ...smb, username: e.target.value }); setErrors({}); }} autoComplete="off" error={errors.username} /><Field label="Password" type="password" value={smb.password} onChange={e => setSmb({ ...smb, password: e.target.value })} autoComplete="new-password" help="DockNest encrypts it and never shows it again." /></div>
      <details className="rt-adv storage-more"><summary>More options</summary>
        <div className="form-grid"><Field label="Port" type="number" min={1} max={65535} value={smb.port} onChange={e => setSmb({ ...smb, port: e.target.value })} placeholder="445" /><Field label="Domain" value={smb.domain} onChange={e => setSmb({ ...smb, domain: e.target.value })} autoComplete="off" help="Only for a Windows domain." /></div>
      </details>
    </>}
    {kind === 'local' && <>
      <AlertPanel variant="info" title="Needs a folder mounted into DockNest">DockNest can only write to a folder you mount into its container. Add these lines to compose.yaml, then restart DockNest.</AlertPanel>
      <div className="dr-code"><div className="dr-code-head"><span>compose.yaml</span><button type="button" className="icon-button" aria-label={copied ? 'Copied' : 'Copy the compose.yaml lines'} title="Copy" onClick={copy}>{copied ? <IconCheck size={18} stroke={1.75} aria-hidden="true" /> : <IconCopy size={18} stroke={1.75} aria-hidden="true" />}</button></div><pre tabIndex={0} aria-label="compose.yaml lines">{COMPOSE_SNIPPET}</pre></div>
      <p className="t-caption">Use a different disk than DockNest’s own data, for example a USB disk or a NAS folder.</p>
      <p className="t-caption"><a className="dr-link" href={LOCAL_DOCS} target="_blank" rel="noopener noreferrer">How local folders work<IconExternalLink size={16} stroke={1.75} aria-hidden="true" /></a></p>
      <Field label="Folder inside DockNest" value={local.path} onChange={e => { setLocal({ ...local, path: e.target.value }); setErrors({}); }} placeholder="/backups/usb" autoComplete="off" spellCheck={false} error={errors.path} help="The mounted path, for example /backups/usb. It must be inside the folder you listed." />
      {local.sameDisk && <AlertPanel variant="warning" title="This folder is on the same disk as DockNest" action={<label className="check"><input type="checkbox" checked={local.same} onChange={e => setLocal({ ...local, same: e.target.checked })} /> I understand</label>}>A disk failure would lose the backups together with DockNest.</AlertPanel>}
    </>}
    {folderField}
    {kind !== 'local' && <p className="t-caption dr-note"><IconInfoCircle size={16} stroke={1.75} aria-hidden="true" /> {labelOf(kind)} cannot keep backups append-only. DockNest tests the drive with a small file and removes it afterwards.</p>}
  </div>;
});

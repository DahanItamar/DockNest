import React from 'react';
import { IconBrandGoogleDrive, IconBrandOnedrive, IconBrandDropbox, IconWorld, IconNetwork, IconFolder, IconDatabaseExport } from '@tabler/icons-react';

// The icon of a backup destination on the Map and in lists: the provider's own Tabler brand mark for Google Drive, OneDrive
// and Dropbox, a plain Tabler icon where there is no brand mark (WebDAV, SMB, local folder) and the storage icon otherwise.
const BY_BACKEND = { drive: IconBrandGoogleDrive, onedrive: IconBrandOnedrive, dropbox: IconBrandDropbox, webdav: IconWorld, smb: IconNetwork };
export const glyphOf = target => (target?.kind === 'local' ? IconFolder : target?.kind === 'rclone' ? BY_BACKEND[target.backend] || IconDatabaseExport : IconDatabaseExport);
export function StorageGlyph({ target, size = 44, stroke = 1.5 }) {
  const Icon = glyphOf(target);
  return <Icon size={size} stroke={stroke} aria-hidden="true" />;
}

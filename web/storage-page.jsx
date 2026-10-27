import React from 'react';
import {StorageReport,useStorageReport} from './storage-report.jsx';
import {StorageTargets} from './storage-targets.jsx';

// One content width and one grid: the report and the destinations share the same edges.
export function StoragePage({api,Field,sites,policies,onChanged,onOpenSites,onSessionExpired}) {
 const {report,error}=useStorageReport(api,onSessionExpired);
 const usage=Object.fromEntries((report?.storages||[]).map(storage=>[storage.id,storage.bytes]));
 return <div className="sr-root"><StorageReport report={report} error={error} onOpenSites={onOpenSites}/><StorageTargets api={api} Field={Field} sites={sites} policies={policies} usage={usage} onChanged={onChanged} onSessionExpired={onSessionExpired}/></div>;
}

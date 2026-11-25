import React from 'react';
import { CheckCircle2, CircleX, TriangleAlert, InfoCircle } from '../icons.jsx';
import { SEVERITY_LABEL } from './model.js';

const ICON = { error: CircleX, warning: TriangleAlert, info: InfoCircle, success: CheckCircle2 };
// A clean coloured icon. With `label` the plain coloured word follows it; without, the word is read by screen readers only.
export function SeverityIcon({ severity, size = 20 }) {
  const Icon = ICON[severity] || InfoCircle;
  return <Icon className={'nc-sev nc-sev-' + severity} size={size} stroke={2} aria-hidden="true" />;
}
export function SeverityLabel({ severity }) {
  return <span className={'nc-sev-label nc-sev-' + severity}><SeverityIcon severity={severity} size={16} />{SEVERITY_LABEL[severity] || 'Info'}</span>;
}

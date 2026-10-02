// Apply a saved preference before styles/React paint; CSP allows this local script.
try {
 const theme=localStorage.getItem('docknest-theme')==='dark'?'dark':'light';
 document.documentElement.dataset.theme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#182131':'#673AB7');
} catch { document.documentElement.dataset.theme='light'; }

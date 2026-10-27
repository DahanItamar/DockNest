// Apply a saved preference before styles/React paint; CSP allows this local script.
try {
 const saved=localStorage.getItem('docknest-theme'),preference=['light','dark','system'].includes(saved)?saved:'light';
 const theme=preference==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):preference;
 document.documentElement.dataset.preference=preference;
 document.documentElement.dataset.theme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#1A191C':'#673AB7');
} catch { document.documentElement.dataset.theme='light';document.documentElement.dataset.preference='light'; }

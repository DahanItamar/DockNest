// Apply a saved preference before styles/React paint; CSP allows this local script.
try {
 const saved=localStorage.getItem('docknest-theme'),preference=['light','dark','system'].includes(saved)?saved:'light';
 const theme=preference==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):preference;
 const savedAccent=localStorage.getItem('docknest-accent'),accent=['teal','blue','indigo','orange'].includes(savedAccent)?savedAccent:'teal';
 document.documentElement.dataset.preference=preference;
 document.documentElement.dataset.theme=theme;
 document.documentElement.dataset.accent=accent;
 // Browser chrome colour until the app sets it from the tokens: the accent solid step (light) or the dark surface.
 const solid={teal:'#0D786C',blue:'#006CBF',indigo:'#3D61D9',orange:'#B24D0F'};
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#18191B':solid[accent]);
} catch { document.documentElement.dataset.theme='light';document.documentElement.dataset.preference='light';document.documentElement.dataset.accent='teal'; }

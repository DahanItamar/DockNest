// Local .env may set NODE_ENV=development for the API. Web releases must use
// React's production runtime regardless of that local server setting.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
await build();

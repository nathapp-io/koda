// Preload a deterministic API in the child without opening a network socket.
const fs = require('node:fs');
const os = require('node:os');
os.homedir = () => process.env.KODA_TEST_HOME;
require('node:module').syncBuiltinESMExports();
const routes = JSON.parse(fs.readFileSync(process.env.KODA_TEST_RESPONSES, 'utf8'));
globalThis.fetch = async (request) => {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const route = cursor === null ? url.pathname : url.pathname + '?cursor=' + cursor;
  if (url.origin !== 'http://fixture.invalid' || !Object.hasOwn(routes, route)) {
    throw new Error('Unexpected fixture request: ' + url);
  }
  if (route === process.env.KODA_TEST_WAIT_FOR_READER) {
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
  return Response.json(routes[route]);
};

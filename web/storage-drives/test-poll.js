// A cloud drive's test can run for minutes when the provider is rate-limiting. The server answers 202 {checking:true} after
// a short wait; this asks GET <path> every few seconds until it ends. Pure: the timer and the request are passed in.
export const STILL_CHECKING = 'Still checking. The provider is slow to answer, so this can take a few minutes. You can leave this page open.';
export async function waitForTest(api, path, { onWait = () => {}, sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)), everyMs = 4000, tries = 150 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    onWait(STILL_CHECKING);
    await sleep(everyMs);
    const answer = await api(path);
    if (answer?.state === 'done') return answer.result;
    if (answer?.state === 'failed') throw Object.assign(new Error(answer.error || 'The test failed.'), { code: answer.code });
    if (answer?.state === 'none') throw new Error('The test is no longer running. Press Test to start it again.');
  }
  throw new Error('The test is still running after 10 minutes. Check the destination again later.');
}

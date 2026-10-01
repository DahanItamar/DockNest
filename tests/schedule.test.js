import test from 'node:test';
import assert from 'node:assert/strict';
import {CronExpressionParser} from 'cron-parser';
import {readSchedule,scheduleExpression,describeSchedule} from '../web/schedule.js';

test('simple 24-hour schedules generate the intended daily, weekly and hourly runs',()=>{
 for(const [expression,next,description] of [
  ['45 23 * * *','2026-10-02T23:45:00.000Z','Every day at 23:45'],
  ['15 9 * * 5','2026-10-02T09:15:00.000Z','Every Friday at 09:15'],
  ['30 * * * *','2026-10-02T08:30:00.000Z','Every hour at minute 30'],
 ]){
  const compiled=scheduleExpression(readSchedule(expression));
  assert.equal(CronExpressionParser.parse(compiled,{currentDate:'2026-10-02T08:00:00Z',tz:'UTC'}).next().toISOString(),next);
  assert.equal(describeSchedule(expression),description);
 }
});
test('complex and non-five-field schedules preserve their original expression',()=>{
 for(const expression of ['0 */6 * * *','0 2 1 * *','0 2 * * 1-5','*/15 * * * *','0 0 2 * * *']){
  const settings=readSchedule(expression);assert.equal(settings.frequency,'custom');assert.equal(scheduleExpression(settings),expression);
 }
});

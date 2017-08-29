/* @flow */
import micro from 'micro';

import { delay } from 'awaiting';
import listen from 'test-listen';

import del from 'redis-functional/del';
import { createClient } from '../redis-client';
import fromURL from './fromURL';
import { commit } from '../commit';
import makeSubscribe from '../subscribe';

jest.unmock('micro');

const takeEvents = (count, stream) =>
  stream.take(count).scan((prev, next) => prev.concat(next), []).toPromise();

describe('subscribe endpoint', () => {
  it('should subscribe', async () => {
    const pubClient = createClient();
    const { service, unsubscribe } = makeSubscribe({
      namespc: 'test-sub',
      history: { size: 10 },
      burst: { time: 10, count: 10 },
    });
    const server = micro(service);
    const url = await listen(server);
    const { events$, abort } = fromURL(url);

    // 1 -> :ok
    // 2 -> first event
    // 3 -> second event
    // 4 -> abort
    const promise = takeEvents(2, events$);
    await delay(100);

    pubClient.publish('test-sub::events', '1:{"type":"first"}');
    pubClient.publish('test-sub::events', `2:{"type":"second","payload":123}`);
    await delay(100);

    abort();
    server.close();
    unsubscribe();
    const val = await promise;
    pubClient.quit();
    expect(val).toMatchSnapshot();
  });

  it('should work with 2 clients', async () => {
    const pubClient = createClient();
    const { service, unsubscribe } = makeSubscribe({
      namespc: 'test-sub',
      redis: {
        url: process.env.REDIS_URL,
      },
      history: { size: 10 },
      burst: { time: 10, count: 1 },
    });
    const server = micro(service);
    const url = await listen(server);

    const http1 = fromURL(url + '?client=1');
    const http2 = fromURL(url + '?client=2');
    await delay(100);

    const promise1 = takeEvents(4, http1.data$);
    const promise2 = takeEvents(3, http2.data$);

    // publish 2 events
    // client 1 will wait until the end
    // client 2 will abort early after the first event
    pubClient.publish('test-sub::events', '1:{"type":"first"}');

    await delay(10);
    http2.abort();

    await delay(10);
    pubClient.publish('test-sub::events', `2:{"type":"second"}`);

    await delay(10);
    http1.abort();

    unsubscribe();

    const val1 = await promise1;
    const val2 = await promise2;

    expect(val1.length).toBe(2);
    expect(val2.length).toBe(1);
  });

  it('should work with empty cache', async () => {
    const commitClient = createClient({ url: process.env.REDIS_URL });

    await del(commitClient, 'test-no-cache::events');
    await del(commitClient, 'test-no-cache::id');
    const events = [
      { type: 'test', payload: 1 },
      { type: 'test', payload: 2 },
      { type: 'test', payload: 3 },
    ];

    await Promise.all(
      events.map(evt => commit(commitClient, evt, 'test-no-cache'))
    );

    const { service, unsubscribe } = makeSubscribe({
      namespc: 'test-no-cache',
      history: { size: 10 },
      burst: { time: 10, count: 10 },
      redis: {
        url: process.env.REDIS_URL,
      },
    });

    const server = micro(service);
    const url = await listen(server);
    const { events$, abort } = fromURL(url, { 'Last-Event-ID': 1 });

    const output = await takeEvents(2, events$);

    abort();
    server.close();
    unsubscribe();

    expect(output).toMatchSnapshot();
  });
});

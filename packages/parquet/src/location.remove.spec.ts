import { describe, expect, it } from 'vitest';
import { resolveLocation } from './location.js';

function fakeClient(batchError: Error) {
  const sent: Array<{ name: string; key: string | undefined }> = [];
  return {
    sent,
    send: async (command: { constructor: { name: string }; input: { Key?: string } }) => {
      sent.push({ name: command.constructor.name, key: command.input.Key });
      if (command.constructor.name === 'DeleteObjectsCommand') throw batchError;
      return {};
    },
  };
}

function locationWith(client: ReturnType<typeof fakeClient>) {
  return resolveLocation({ s3: { client, bucket: 'b' } } as never);
}

describe('S3 location remove on MinIO', () => {
  it('falls back to single deletes on MissingContentMD5 and stops trying the batch call', async () => {
    const client = fakeClient(Object.assign(new Error('md5'), { name: 'MissingContentMD5' }));
    const location = locationWith(client);

    await location.remove(['a', 'b']);
    await location.remove(['c']);

    expect(client.sent.filter((call) => call.name === 'DeleteObjectsCommand')).toHaveLength(1);
    expect(
      client.sent.filter((call) => call.name === 'DeleteObjectCommand').map((call) => call.key),
    ).toEqual(['telescope/a', 'telescope/b', 'telescope/c']);
  });

  it('rethrows any other batch error', async () => {
    const location = locationWith(fakeClient(new Error('boom')));
    await expect(location.remove(['a'])).rejects.toThrow('boom');
  });
});

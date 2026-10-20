import { InMemoryStorageProvider, SqliteStorageProvider } from '@dudousxd/nestjs-telescope';
import { describeStorageProvider } from './storage-conformance.js';

describeStorageProvider('InMemoryStorageProvider', () => new InMemoryStorageProvider());

describeStorageProvider('SqliteStorageProvider', () => new SqliteStorageProvider());

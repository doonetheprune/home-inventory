import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { storageContract } from './storage-contract';

storageContract('in-memory', () => createMemoryStorage());

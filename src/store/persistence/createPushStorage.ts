import fs from 'node:fs';
import { Config } from '../../configurations';
import { MemoryPushStorage, PushStorage } from './PushStorage';
import { SqlitePushStorage } from './SqlitePushStorage';
import { MysqlPushStorage } from './MysqlPushStorage';

export function createPushStorage(config: Config): PushStorage {
  switch (config.PUSH_STORAGE ?? 'memory') {
    case 'memory': return new MemoryPushStorage();
    case 'sqlite': return new SqlitePushStorage(config.PUSH_SQLITE_PATH);
    case 'mysql': return new MysqlPushStorage({
      host: config.PUSH_MYSQL_HOST, port: config.PUSH_MYSQL_PORT,
      database: config.PUSH_MYSQL_DATABASE, user: config.PUSH_MYSQL_USER, password: config.PUSH_MYSQL_PASSWORD,
      ssl: config.PUSH_MYSQL_TLS ? {
        rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2',
        ...(config.PUSH_MYSQL_CA_PATH ? { ca: fs.readFileSync(config.PUSH_MYSQL_CA_PATH) } : {}),
      } : undefined,
    });
  }
}

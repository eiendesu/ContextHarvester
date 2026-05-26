import { ContextHarvesterPanel } from '../panel';
import { buildConfig } from '../settings';

export async function rebuildIndex(panel: ContextHarvesterPanel): Promise<void> {
  await panel.runAction('rebuild_index', buildConfig());
}

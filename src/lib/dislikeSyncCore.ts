export interface DislikeIntent { uid: number; id: string; disliked: boolean; revision: number }
export interface DislikeAccount { uid: number; token: string }

/** Last intent wins, independently for each account and track. No credentials
 * belong in this persisted queue. Revision protects changes made during a send. */
export function replaceDislikeIntent(list: DislikeIntent[], uid: number, id: string, disliked: boolean): DislikeIntent[] {
  const previous = list.find(item => item.uid === uid && item.id === id);
  return [...list.filter(item => item !== previous), { uid, id, disliked, revision: (previous?.revision || 0) + 1 }];
}

export async function drainDislikeIntents(io: {
  read: () => DislikeIntent[];
  write: (entries: DislikeIntent[]) => void;
  account: () => DislikeAccount | null;
  send: (token: string, ids: string[], disliked: boolean) => Promise<void>;
  acknowledged?: (entries: DislikeIntent[]) => void;
}): Promise<'idle' | 'offline'> {
  for (;;) {
    const account = io.account();
    if (!account) return 'idle';
    const first = io.read().find(entry => entry.uid === account.uid);
    if (!first) return 'idle';
    const batch = io.read().filter(entry => entry.uid === account.uid && entry.disliked === first.disliked).slice(0, 100);
    try { await io.send(account.token, batch.map(entry => entry.id), first.disliked); }
    catch { return 'offline'; }
    io.write(io.read().filter(entry => !batch.some(sent => sent.uid === entry.uid && sent.id === entry.id && sent.revision === entry.revision)));
    io.acknowledged?.(batch);
  }
}

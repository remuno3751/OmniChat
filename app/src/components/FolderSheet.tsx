import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { newFolderId } from '../folders';
import { useT } from '../i18n';
import { applyUpsert, useStore } from '../store';
import { confirmDialog } from '../ui/confirm';
import { Btn, Field, Hint, Sheet } from '../ui/kit';
import { toast } from '../ui/toast';

/** Create (folderId null) or rename / delete a chat folder. Deleting a folder returns its chats to Unclassified. */
export default function FolderSheet({ visible, folderId, onClose }: { visible: boolean; folderId: string | null; onClose: () => void }) {
  const tr = useT();
  const folder = useStore((s) => (folderId ? s.folders[folderId] : undefined));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (visible) setName(folder?.name ?? ''); }, [visible, folder?.name]);

  const save = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      applyUpsert({ folders: [await api.putFolder(folderId ?? newFolderId(), { name: n })] });
      onClose();
    } catch (e: any) { toast(e.message || tr('folder.saveFailed'), 'error'); }
    setBusy(false);
  };

  const del = async () => {
    if (!folderId || !(await confirmDialog(tr('folder.deleteTitle'), tr('folder.deleteMsg', { name: folder?.name ?? '' }), tr('common.delete')))) return;
    try {
      applyUpsert({ folders: [await api.deleteFolder(folderId)] });
      onClose();
    } catch (e: any) { toast(e.message || tr('list.deleteFailed'), 'error'); }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      width={420}
      title={folderId ? tr('folder.renameTitle') : tr('folder.new')}
      footer={
        <>
          <Btn primary label={busy ? tr('set.saving') : tr('common.save')} disabled={busy || !name.trim()} onPress={save} />
          <Btn label={tr('common.cancel')} onPress={onClose} />
          {!!folderId && <Btn danger label={tr('common.delete')} onPress={del} />}
        </>
      }
    >
      <Field label={tr('set.name')} value={name} onChangeText={setName} placeholder={tr('folder.namePh')} autoFocus onSubmit={save} />
      {!!folderId && <Hint>{tr('folder.deleteHint')}</Hint>}
    </Sheet>
  );
}

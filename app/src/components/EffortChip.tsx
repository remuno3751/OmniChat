import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Effort } from '../protocol';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import { Check, Hint, Sheet } from '../ui/kit';
import EffortPicker from './EffortPicker';
import Icon from './Icon';
import Tip from './Tip';

interface Props {
  /** one-shot effort for the next message only */
  oneShot: Effort | null;
  /** the chat-level effort (conversation.effort) */
  chat: Effort | null;
  unsupported: boolean;
  onOneShot: (e: Effort | null) => void;
  onPin: (e: Effort | null) => void;
}

/** Effort selector next to the composer. Picking a level applies to the next message only, unless "Keep for this chat" is on. */
export default function EffortChip({ oneShot, chat, unsupported, onOneShot, onPin }: Props) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState(false);

  const shown = oneShot ?? chat;
  const level = tr(shown ? `effort.${shown}` : 'effort.default');
  const label = unsupported
    ? tr('composer.effort.na')
    : oneShot ? tr('composer.effort.labelNext', { level })
    : chat ? tr('composer.effort.labelChat', { level })
    : tr('composer.effort.label', { level });

  const choose = (e: Effort | null) => {
    // the popup stays open so the slider can be adjusted further; Esc / X / backdrop closes it
    if (pin) { onPin(e); onOneShot(null); } else onOneShot(e);
  };

  return (
    <>
      <Tip label={tr('effort.title')}>
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={tr('effort.title')}
          style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: shown && !unsupported ? t.accent : t.border, borderRadius: th.r(14), paddingHorizontal: 10, paddingVertical: 4, opacity: unsupported ? 0.55 : 1 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="filter" size={14} color={shown && !unsupported ? t.accentInk : t.sub} />
            <Text style={{ color: shown && !unsupported ? t.accentInk : t.sub, fontSize: 12, fontWeight: '600' }}>{label}</Text>
          </View>
        </Pressable>
      </Tip>
      {/* the keep-for-this-chat switch sits in the footer: it stays visible without scrolling, whatever the screen height */}
      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title={tr('effort.title')}
        width={440}
        footer={
          <View style={{ flex: 1 }}>
            <Check
              label={tr('composer.effort.keepChat')}
              value={pin}
              onChange={setPin}
              hint={pin ? tr('composer.effort.keepOn') : tr('composer.effort.keepOff')}
            />
          </View>
        }
      >
        {unsupported && <Hint danger>{tr('composer.effort.unsupported')}</Hint>}
        <EffortPicker value={oneShot ?? chat} onChange={choose} disabled={unsupported} />
      </Sheet>
    </>
  );
}

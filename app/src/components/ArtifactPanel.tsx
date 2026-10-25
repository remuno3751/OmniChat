import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Artifact, ArtifactType } from '../artifacts';
import { deliverBlobWeb, deliverText } from '../apiHistory';
import { getServerUrl, getToken } from '../api';
import { useT } from '../i18n';
import { useTheme, useThemeDef } from '../theme';
import type { Theme } from '../theme';
import { copyText } from '../ui/clipboard';
import { toast } from '../ui/toast';
import { buildEml, buildMailto, emailAll, emailPlaceholders, parseEmail } from '../email';
import { IMPORT_ACCEPT, IMPORT_MAX_BYTES, ImportError, importFileToArtifact } from '../importFile';
import DocxPreview from './previews/DocxPreview';
import EmailPreview from './previews/EmailPreview';
import PptxPreview from './previews/PptxPreview';
import XlsxPreview from './previews/XlsxPreview';
import Icon from './Icon';
import type { IconName } from './Icon';
import Markdown from './Markdown';
import CodeText from './CodeText';

/*
 * Side panel for one artifact: Preview / Source tabs, Copy, Download (with format choices), Edit (local only),
 * Open file (web: import a .docx/.xlsx/.pptx/.eml/.md/.csv file as an artifact) and an optional "Use in chat".
 * Edits never leave the device; they only change what is copied, downloaded or sent.
 * HTML is previewed in a fully sandboxed iframe on web (no scripts, no same-origin); native shows the source text.
 */

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

type Fmt = 'md' | 'html' | 'docx' | 'pptx' | 'xlsx' | 'eml';
type Tab = 'preview' | 'source';

const TYPE_ICON: Record<ArtifactType, IconName> = {
  markdown: 'docMarkdown', html: 'docHtml', docx: 'docWord', pptx: 'docSlides', xlsx: 'docSheet', email: 'docMail',
};
const FORMATS: Record<ArtifactType, Fmt[]> = {
  markdown: ['md', 'docx', 'pptx', 'xlsx'],
  html: ['html'],
  docx: ['docx', 'md'],
  pptx: ['pptx', 'md'],
  xlsx: ['xlsx', 'md'],
  email: ['eml', 'md'],
};
const FMT_KEY: Record<Fmt, string> = {
  md: 'art.fmt.md', html: 'art.fmt.html', docx: 'art.fmt.docx', pptx: 'art.fmt.pptx', xlsx: 'art.fmt.xlsx', eml: 'art.fmt.eml',
};
const TEXT_MIME: Partial<Record<Fmt, string>> = { md: 'text/markdown', html: 'text/html', eml: 'message/rfc822' };

/** Filename stem: characters outside letters, digits, space, `.`, `_`, `-` become `_`. */
export function safeArtifactName(title: string): string {
  const s = (title || '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/^[ .]+|[ .]+$/g, '');
  return s || 'artifact';
}

/** Chat text for an imported artifact: a fenced `artifact` block whose fence is longer than any backtick run in the content. */
export function artifactFenceText(type: ArtifactType, title: string, content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}artifact type=${type} title="${title.replace(/"/g, "'")}"\n${content}\n${fence}`;
}

export default function ArtifactPanel({ artifact, onClose, onUseInChat }: {
  artifact: Artifact;
  onClose: () => void;
  onUseInChat?: (text: string) => void;
}) {
  const t = useTheme();
  const th = useThemeDef();
  const tr = useT();
  const [override, setOverride] = useState<Artifact | null>(null);
  const [content, setContent] = useState(artifact.content);
  const [tab, setTab] = useState<Tab>('preview');
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<Fmt | null>(null);
  const [error, setError] = useState('');

  // A new artifact (or a streamed update of the same one) replaces the local copy and drops an opened file.
  useEffect(() => {
    setOverride(null);
    setContent(artifact.content);
    setError('');
    setMenuOpen(false);
  }, [artifact.title, artifact.type, artifact.content]);

  const cur = override ?? artifact;
  const mail = cur.type === 'email' ? parseEmail(content) : null;
  const placeholders = mail ? emailPlaceholders(mail.body) : [];

  const onCopy = async () => {
    const ok = await copyText(content);
    toast(ok ? tr('msg.copied') : tr('msg.copyFailed'), ok ? 'ok' : 'error');
  };

  const onCopyBody = async () => {
    if (!mail) return;
    const ok = await copyText(mail.body);
    toast(ok ? tr('msg.copied') : tr('msg.copyFailed'), ok ? 'ok' : 'error');
  };

  const onCopyAll = async () => {
    if (!mail) return;
    const ok = await copyText(emailAll(mail));
    toast(ok ? tr('msg.copied') : tr('msg.copyFailed'), ok ? 'ok' : 'error');
  };

  const onOpenMail = async () => {
    if (!mail) return;
    const { url, truncated } = buildMailto(mail);
    try {
      if (Platform.OS === 'web') (globalThis as any).location.href = url;
      else await Linking.openURL(url);
    } catch {
      toast(tr('art.mail.openFailed'), 'error');
      return;
    }
    if (truncated) toast(tr('art.mail.truncated'), 'info');
  };

  const download = async (fmt: Fmt) => {
    setError('');
    setMenuOpen(false);
    const name = `${safeArtifactName(cur.title)}.${fmt}`;
    const textMime = TEXT_MIME[fmt];
    if (textMime) {
      try {
        const text = fmt === 'eml' ? buildEml(parseEmail(content)) : content;
        await deliverText(name, text, textMime);
      } catch (e: any) { toast(e?.message || tr('art.downloadFailed'), 'error'); }
      return;
    }
    // docx / pptx / xlsx need server-side conversion.
    if (Platform.OS !== 'web') { toast(tr('art.downloadWebOnly'), 'error'); return; }
    setBusy(fmt);
    try {
      const res = await fetch(`${getServerUrl()}/artifacts/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify({ type: fmt, title: cur.title, markdown: content }),
      });
      if (!res.ok) throw new Error(tr('art.conversionHttp', { status: res.status }));
      const blob = await res.blob();
      deliverBlobWeb(name, blob);
      toast(tr('art.downloaded'), 'ok');
    } catch (e: any) {
      setError(e?.message || tr('art.conversionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const openFile = () => {
    setMenuOpen(false);
    if (Platform.OS !== 'web') { toast(tr('art.openWebOnly'), 'error'); return; }
    const d: any = (globalThis as any).document;
    const input = d.createElement('input');
    input.type = 'file';
    input.accept = IMPORT_ACCEPT;
    input.style.display = 'none';
    input.onchange = async () => {
      const file: File | undefined = input.files?.[0];
      input.remove();
      if (!file) return;
      if (file.size > IMPORT_MAX_BYTES) { toast(tr('art.openTooLarge'), 'error'); return; }
      try {
        const a = await importFileToArtifact(file);
        setOverride(a);
        setContent(a.content);
        setEditing(false);
        setTab('preview');
        setError('');
        toast(tr('art.opened', { name: file.name }), 'ok');
      } catch (e: any) {
        toast(tr(e instanceof ImportError ? e.message : 'art.openFailed'), 'error');
      }
    };
    d.body.appendChild(input);
    input.click();
  };

  const useInChat = () => {
    if (!onUseInChat) return;
    onUseInChat(override ? artifactFenceText(cur.type, cur.title, content) : content);
  };

  const toggleEdit = () => {
    if (editing) { setEditing(false); return; }
    setEditing(true);
    setTab('source');
  };

  let body: React.ReactNode;
  if (tab === 'source') {
    body = editing ? (
      <TextInput
        multiline
        value={content}
        onChangeText={setContent}
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical="top"
        accessibilityLabel={tr('art.sourceEditor')}
        style={[styles.editor, styles.mono, { color: t.text, backgroundColor: t.input, borderColor: t.border, borderRadius: th.r(6) }]}
      />
    ) : (
      <ScrollView style={styles.fill} contentContainerStyle={styles.pad}>
        <CodeText body={content} lang={cur.type === 'markdown' ? 'md' : cur.type} t={t} />
      </ScrollView>
    );
  } else if (cur.type === 'html') {
    if (Platform.OS === 'web') {
      body = (
        <View style={styles.fill}>
          {React.createElement('iframe', {
            srcDoc: content,
            sandbox: '',
            title: cur.title,
            style: { border: 0, width: '100%', height: '100%', background: '#fff' },
          })}
        </View>
      );
    } else {
      body = (
        <ScrollView style={styles.fill} contentContainerStyle={styles.pad}>
          <Text style={[styles.note, { color: t.sub }]}>{tr('art.htmlWebOnly')}</Text>
          <CodeText body={content} lang="html" t={t} />
        </ScrollView>
      );
    }
  } else if (cur.type === 'docx') {
    body = <DocxPreview content={content} title={cur.title} />;
  } else if (cur.type === 'pptx') {
    body = <PptxPreview content={content} title={cur.title} />;
  } else if (cur.type === 'xlsx') {
    body = <XlsxPreview content={content} title={cur.title} />;
  } else if (cur.type === 'email') {
    body = <EmailPreview content={content} />;
  } else {
    body = (
      <ScrollView style={styles.fill} contentContainerStyle={styles.pad}>
        <Markdown text={content} t={t} />
      </ScrollView>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { borderBottomColor: t.border }]}>
        <Icon name={TYPE_ICON[cur.type]} size={20} color={t.accentInk} />
        <Text numberOfLines={1} style={[styles.title, { color: t.text }]}>{cur.title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={tr('art.closePanel')} hitSlop={8} onPress={onClose} style={[styles.iconBtn, { borderRadius: th.r(6) }]}>
          <Icon name="close" size={20} color={t.sub} />
        </Pressable>
      </View>

      <View style={[styles.tabs, { borderBottomColor: t.border }]}>
        {(['preview', 'source'] as Tab[]).map((k) => {
          const selected = tab === k;
          return (
            <Pressable
              key={k}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setTab(k)}
              style={[styles.tab, selected && { borderBottomColor: t.accent }]}
            >
              <Icon name={k === 'preview' ? 'preview' : 'source'} size={16} color={selected ? t.text : t.sub} />
              <Text style={{ color: selected ? t.text : t.sub, fontWeight: selected ? '700' : '400', fontSize: 14 }}>
                {k === 'preview' ? tr('art.tab.preview') : tr('art.tab.source')}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.actions, { borderBottomColor: t.border }]}>
        <Act icon="copy" label={tr('common.copy')} onPress={onCopy} t={t} />
        {mail ? (
          <>
            <Act icon="copy" label={tr('art.mail.copyBody')} onPress={onCopyBody} t={t} />
            <Act icon="copy" label={tr('art.mail.copyAll')} onPress={onCopyAll} t={t} />
            <Act icon="send" label={tr('art.mail.openMail')} onPress={onOpenMail} t={t} />
          </>
        ) : null}
        <Act icon="download" label={tr('art.download')} active={menuOpen} onPress={() => setMenuOpen((v) => !v)} t={t} />
        <Act icon="folder" label={tr('art.open')} onPress={openFile} t={t} />
        <Act icon={editing ? 'check' : 'edit'} label={editing ? tr('art.done') : tr('common.edit')} active={editing} onPress={toggleEdit} t={t} />
        {onUseInChat ? <Act icon="send" label={tr('art.useInChat')} onPress={useInChat} t={t} /> : null}
      </View>

      {placeholders.length > 0 ? (
        <Text style={[styles.note, { color: t.sub, marginHorizontal: 12, marginTop: 8 }]}>
          {tr('art.mail.placeholders', { n: placeholders.length })}
        </Text>
      ) : null}

      {menuOpen ? (
        <View style={[styles.menu, { borderBottomColor: t.border, backgroundColor: t.panel }]}>
          {FORMATS[cur.type].map((fmt) => (
            <Pressable
              key={fmt}
              accessibilityRole="button"
              accessibilityLabel={tr('art.downloadA11y', { format: tr(FMT_KEY[fmt]) })}
              disabled={busy !== null}
              onPress={() => download(fmt)}
              style={[styles.choice, { borderColor: t.border, backgroundColor: t.bg, borderRadius: th.r(6) }]}
            >
              <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{tr(FMT_KEY[fmt])}</Text>
            </Pressable>
          ))}
          {busy ? (
            <View style={styles.busy}>
              <ActivityIndicator size="small" color={t.accentInk} />
              <Text style={{ color: t.sub, fontSize: 13 }}>{tr('art.converting')}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {error ? <Text accessibilityRole="alert" style={[styles.error, { color: t.danger }]}>{error}</Text> : null}

      <View style={styles.fill}>{body}</View>
    </View>
  );
}

function Act({ icon, label, onPress, active = false, t }: {
  icon: IconName; label: string; onPress: () => void; active?: boolean; t: Theme;
}) {
  const th = useThemeDef();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.act, { borderColor: active ? t.accent : t.border, backgroundColor: active ? t.userBubble : t.panel, borderRadius: th.r(6) }]}
    >
      <Icon name={icon} size={16} color={t.text} />
      <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

// Web: each flex box between the side panel and a preview's ScrollView keeps minHeight 0, so the ScrollView gets a
// bounded height (and the wheel scrolls it) instead of growing to its content.
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  fill: { flex: 1, minHeight: 0 },
  pad: { padding: 16 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  note: { fontSize: 13, marginBottom: 8 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '700' },
  iconBtn: { padding: 4 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  act: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1,
  },
  menu: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  choice: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 4 },
  error: { fontSize: 13, paddingHorizontal: 12, paddingVertical: 6 },
  editor: {
    flex: 1, borderWidth: 1, margin: 12, padding: 10,
  },
});

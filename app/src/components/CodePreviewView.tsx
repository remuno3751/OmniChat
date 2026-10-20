import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import WebView from 'react-native-webview';

/**
 * Native preview: the assembled document runs in a WebView with no network access of its own
 * (the CSP meta in the document decides what loads). Only about: and data: may be opened.
 */
function CodePreviewView({ html, runScripts }: { html: string; runScripts: boolean; allowExternal?: boolean }) {
  const source = useMemo(() => ({ html, baseUrl: 'about:blank' }), [html]);
  return (
    <WebView
      style={styles.fill}
      source={source}
      originWhitelist={['about:*', 'data:*']}
      javaScriptEnabled={runScripts}
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      onShouldStartLoadWithRequest={(r) => r.url === 'about:blank' || r.url.startsWith('data:')}
    />
  );
}

export default React.memo(CodePreviewView);

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#fff' },
});

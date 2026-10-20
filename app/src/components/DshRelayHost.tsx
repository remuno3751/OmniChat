import { useEffect } from 'react';
import { useDevice } from '../deviceSettings';
import { getServerUrl, getToken } from '../api';
import { isRelaySupported, stopDshRelay, syncDshRelay } from '../dshRelayClient';

/** Keeps the DeepSeek Harness relay in line with the device settings while logged in. Renders nothing. */
export default function DshRelayHost() {
  const dsh = useDevice((s) => s.dsh);
  const supported = isRelaySupported();
  const token = getToken();
  const serverUrl = getServerUrl();

  useEffect(() => {
    syncDshRelay(
      supported && dsh.enabled && dsh.pairing && token && serverUrl
        ? { port: dsh.port, pairing: dsh.pairing, bridgeName: dsh.bridgeName, serverUrl, token }
        : null,
    );
  }, [supported, dsh.enabled, dsh.port, dsh.pairing, dsh.bridgeName, serverUrl, token]);

  useEffect(() => () => stopDshRelay(), []);

  return null;
}

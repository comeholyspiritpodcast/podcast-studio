/**
 * webrtcService.js — mesh WebRTC over the Socket.IO signalling server.
 *
 * Mesh topology is fine for the 2–5 person interviews this studio targets.
 * The transmitted stream only exists so people can see and hear each other;
 * the footage that matters is captured locally by recorderService.
 *
 * Events emitted: 'peer', 'peer-left', 'state', 'local', 'recording:start',
 * 'recording:stop', 'chat', 'error'.
 */

import { RTC_CONFIG, MEDIA_CONSTRAINTS, MEDIA_CONSTRAINTS_FALLBACK, API_BASE } from '../config.js';

export class WebRTCService extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.localStream = null;
    this.peers = new Map(); // socketId -> { pc, name, stream, polite }
    this.displayName = 'Host';
    this.roomId = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ---------------- local media ---------------- */

  /**
   * Requests the camera/mic with the strict echo-cancellation constraints.
   * Some devices throw OverconstrainedError on the exact{} form, so this
   * retries once with the relaxed (ideal-only) constraints rather than
   * failing the whole join over it.
   */
  static async rawUserMedia({ audioDeviceId, videoDeviceId } = {}) {
    const build = (base) => ({
      audio: { ...base.audio, ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}) },
      video: { ...base.video, ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}) }
    });

    try {
      return await navigator.mediaDevices.getUserMedia(build(MEDIA_CONSTRAINTS));
    } catch (err) {
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotReadableError') throw err;
      return navigator.mediaDevices.getUserMedia(build(MEDIA_CONSTRAINTS_FALLBACK));
    }
  }

  /** Adopts a stream acquired elsewhere (the pre-join screen), skipping a second permission prompt. */
  adoptLocalMedia(stream) {
    this.localStream = stream;
    this.emit('local', { stream });
    return stream;
  }

  async startLocalMedia({ audioDeviceId, videoDeviceId } = {}) {
    const stream = await WebRTCService.rawUserMedia({ audioDeviceId, videoDeviceId });

    if (this.localStream) {
      // Swap tracks in place so live peers are not renegotiated unnecessarily.
      for (const [, peer] of this.peers) {
        for (const track of stream.getTracks()) {
          const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
          if (sender) await sender.replaceTrack(track);
        }
      }
      this.localStream.getTracks().forEach((t) => t.stop());
    }

    this.localStream = stream;
    this.emit('local', { stream });
    return stream;
  }

  static async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      audio: devices.filter((d) => d.kind === 'audioinput'),
      video: devices.filter((d) => d.kind === 'videoinput')
    };
  }

  setMuted(muted) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.publishState({ muted });
  }

  setCameraOff(off) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach((t) => (t.enabled = !off));
    this.publishState({ cameraOff: off });
  }

  publishState(patch) {
    this.state = Object.assign({ muted: false, cameraOff: false, name: this.displayName }, this.state, patch);
    if (this.socket) this.socket.emit('state', this.state);
  }

  /* ---------------- signalling ---------------- */

  join(roomId, displayName, apiBase = API_BASE) {
    this.roomId = roomId;
    this.displayName = displayName;

    // io() is provided by /socket.io/socket.io.js loaded in index.html.
    this.socket = apiBase ? window.io(apiBase, { withCredentials: true }) : window.io({ withCredentials: true });

    this.socket.on('connect', () => this.socket.emit('join', { room: roomId, name: displayName }));

    // Peers already in the room: we make the offers to them.
    this.socket.on('peers', async (list) => {
      for (const peer of list) {
        this.emit('peer', { id: peer.id, name: peer.name, muted: peer.muted, cameraOff: peer.cameraOff });
        await this.connectTo(peer.id, peer.name, true);
      }
    });

    // A newcomer: they will offer to us, so we only prepare the slot.
    this.socket.on('peer-joined', async ({ id, name }) => {
      this.emit('peer', { id, name });
      await this.connectTo(id, name, false);
    });

    this.socket.on('signal', ({ from, data }) => this.handleSignal(from, data));

    this.socket.on('peer-state', (state) => this.emit('state', state));

    this.socket.on('peer-left', ({ id }) => {
      const peer = this.peers.get(id);
      if (peer) peer.pc.close();
      this.peers.delete(id);
      this.emit('peer-left', { id });
    });

    this.socket.on('recording:start', (payload) => this.emit('recording:start', payload));
    this.socket.on('recording:stop', (payload) => this.emit('recording:stop', payload));
    this.socket.on('chat', (payload) => this.emit('chat', payload));
    this.socket.on('connect_error', (err) => this.emit('error', { message: err.message }));
  }

  async connectTo(id, name, initiator) {
    if (this.peers.has(id)) return this.peers.get(id);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = { pc, name, stream: new MediaStream(), makingOffer: false, polite: !initiator };
    this.peers.set(id, entry);

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));
    }

    pc.ontrack = ({ track }) => {
      entry.stream.addTrack(track);
      this.emit('peer', { id, name: entry.name, stream: entry.stream });
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('signal', { to: id, data: { candidate } });
    };

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        this.socket.emit('signal', { to: id, data: { description: pc.localDescription } });
      } catch (err) {
        this.emit('error', { message: err.message });
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    if (initiator) {
      // Triggers onnegotiationneeded once tracks are attached.
      try {
        await pc.setLocalDescription(await pc.createOffer());
        this.socket.emit('signal', { to: id, data: { description: pc.localDescription } });
      } catch (err) {
        this.emit('error', { message: err.message });
      }
    }

    return entry;
  }

  /** Perfect-negotiation handling of offers, answers and ICE candidates. */
  async handleSignal(from, data) {
    const entry = this.peers.get(from) || (await this.connectTo(from, 'Guest', false));
    const { pc } = entry;

    try {
      if (data.description) {
        const offerCollision =
          data.description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');

        if (offerCollision && !entry.polite) return;

        if (offerCollision) await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));

        if (data.description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.socket.emit('signal', { to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
    } catch (err) {
      this.emit('error', { message: err.message });
    }
  }

  /* ---------------- room-wide recording sync ---------------- */

  broadcastRecordStart(sessionId) {
    if (this.socket) this.socket.emit('recording:start', { sessionId });
  }

  broadcastRecordStop() {
    if (this.socket) this.socket.emit('recording:stop', {});
  }

  leave() {
    for (const [, peer] of this.peers) peer.pc.close();
    this.peers.clear();
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this.socket) this.socket.disconnect();
    this.socket = null;
  }
}

/**
 * Audio level meter driven by the Web Audio API. Returns a stop() function.
 */
export function meterStream(stream, onLevel) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
    onLevel(Math.min(1, peak * 1.6));
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    source.disconnect();
    ctx.close().catch(() => {});
  };
}

// Social Hub — peer-to-peer voice.
// A WebRTC audio mesh. Signaling rides a separate Supabase Realtime channel
// ("realtime:voice"); mic audio flows browser<->browser directly. No token
// server, no extra account. Bridged to Godot via window.SHVoice.
(function () {
  var SUPA_URL = "https://dojgwvqmgplbfombrqic.supabase.co";
  var KEY = "sb_publishable_9OTQ1u2dCAf-aG-hfS7qkA_cnnIox4G";
  var WS_URL = SUPA_URL.replace("https://", "wss://") +
    "/realtime/v1/websocket?apikey=" + KEY + "&vsn=1.0.0";
  var ICE = [{ urls: "stun:stun.l.google.com:19302" },
             { urls: "stun:global.stun.twilio.com:3478" }];

  var ws = null, ref = 0, joined = false, myId = 0;
  var localStream = null, started = false;
  var myChannel = "global";   // "global" (open voice) or "party:<id>" (private)
  var peers = {};   // id -> { pc, audioEl, volume }
  var peerCh = {};  // id -> channel; only same-channel peers are connected

  function log() { try { console.log.apply(console, ["[voice]"].concat([].slice.call(arguments))); } catch (e) {} }

  function send(topic, event, payload) {
    if (ws && ws.readyState === 1)
      ws.send(JSON.stringify({ topic: topic, event: event, payload: payload, ref: String(++ref) }));
  }
  function bcast(event, data) {
    send("realtime:voice", "broadcast", { type: "broadcast", event: event, payload: data });
  }

  function ensureMic() {
    if (localStream) return Promise.resolve(localStream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(null);
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function (s) { localStream = s; log("mic on"); return s; })
      .catch(function (e) { log("mic denied/unavailable", e && e.name); return null; });
  }

  function connectWS() {
    ws = new WebSocket(WS_URL);
    ws.onopen = function () { send("realtime:voice", "phx_join", { config: { broadcast: { self: false } } }); };
    ws.onmessage = function (m) {
      var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg.event === "phx_reply" && !joined && msg.payload && msg.payload.status === "ok") {
        joined = true; log("signaling joined"); bcast("vhi", { i: myId, ch: myChannel });
      } else if (msg.event === "broadcast") {
        onSignal(msg.payload || {});
      }
    };
    ws.onclose = function () { joined = false; setTimeout(connectWS, 2000); };
    ws.onerror = function () { log("ws error"); };
    setInterval(function () { send("phoenix", "heartbeat", {}); }, 25000);
  }

  function newPC(id) {
    var pc = new RTCPeerConnection({ iceServers: ICE });
    if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    pc.onicecandidate = function (e) { if (e.candidate) bcast("vice", { i: myId, t: id, c: e.candidate }); };
    pc.ontrack = function (e) {
      var rec = peers[id] || {};
      var el = rec.audioEl;
      if (!el) { el = document.createElement("audio"); el.autoplay = true; document.body.appendChild(el); }
      el.srcObject = e.streams[0];
      el.volume = rec.volume == null ? 1 : rec.volume;
      peers[id] = { pc: pc, audioEl: el, volume: el.volume };
    };
    peers[id] = Object.assign(peers[id] || {}, { pc: pc });
    return pc;
  }

  function onSignal(p) {
    var ev = p.event, d = p.payload || {};
    var from = d.i;
    if (!from || from === myId) return;
    if (d.t && d.t !== myId) return;            // targeted to someone else
    switch (ev) {
      case "vhi":
        peerCh[from] = d.ch || "global";
        if (peerCh[from] === myChannel) {        // only connect same-channel peers
          if (myId < from) createOffer(from);    // lower id initiates (no glare)
          else if (!peers[from]) bcast("vhi", { i: myId, ch: myChannel });
        } else if (peers[from]) {
          removePeer(from);                       // peer moved to another channel
        }
        break;
      case "voffer": handleOffer(from, d.sdp); break;
      case "vanswer":
        if (peers[from] && peers[from].pc) peers[from].pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        break;
      case "vice":
        if (peers[from] && peers[from].pc && d.c)
          peers[from].pc.addIceCandidate(new RTCIceCandidate(d.c)).catch(function () {});
        break;
      case "vbye": removePeer(from); break;
    }
  }

  function createOffer(id) {
    ensureMic().then(function () {
      var pc = newPC(id);
      return pc.createOffer().then(function (o) { return pc.setLocalDescription(o).then(function () {
        bcast("voffer", { i: myId, t: id, sdp: pc.localDescription });
      }); });
    });
  }
  function handleOffer(id, sdp) {
    ensureMic().then(function () {
      var pc = newPC(id);
      return pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(function () {
        return pc.createAnswer();
      }).then(function (a) { return pc.setLocalDescription(a).then(function () {
        bcast("vanswer", { i: myId, t: id, sdp: pc.localDescription });
      }); });
    });
  }
  function removePeer(id) {
    var r = peers[id]; if (!r) return;
    try { r.pc && r.pc.close(); } catch (e) {}
    if (r.audioEl) r.audioEl.remove();
    delete peers[id];
  }

  window.SHVoice = {
    start: function (id) {
      if (started) return; started = true;
      myId = id | 0;
      ensureMic().then(function () { connectWS(); });
      window.addEventListener("beforeunload", function () { try { bcast("vbye", { i: myId }); } catch (e) {} });
    },
    // switch voice channel: "global" (open) or "party:<id>" (private group)
    setChannel: function (ch) {
      ch = ch || "global";
      if (ch === myChannel) return;
      myChannel = ch;
      Object.keys(peers).forEach(function (id) { if (peerCh[id] !== myChannel) removePeer(id); });
      bcast("vhi", { i: myId, ch: myChannel });   // re-pair with same-channel peers
      log("channel ->", ch);
    },
    // proximity: Godot sets 0..1 volume per peer by in-game distance
    setVolume: function (id, v) {
      var r = peers[id]; if (r) { r.volume = Math.max(0, Math.min(1, v)); if (r.audioEl) r.audioEl.volume = r.volume; }
    },
    muteMic: function (m) { if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !m; }); },
    active: function () { return started && !!localStream; }
  };
  log("module ready");
})();

import { closeQuiet, createBindZero, ffmpegLogInitialOutput, listenZero, safePrintFFmpegArguments } from './compat';
import type { BinarySensor, Camera, DeviceProvider, DeviceCreator, DeviceCreatorSettings, EventListenerRegister, FFmpegInput, Intercom, Lock, MediaObject, MixinProvider, MotionSensor, PictureOptions, ResponseMediaStreamOptions, ScryptedDevice, ScryptedDeviceType as ScryptedDeviceTypeValue, ScryptedInterface as ScryptedInterfaceValue, Setting, Settings, SettingValue, VideoCamera, WritableDeviceState } from '@scrypted/sdk';
import child_process, { ChildProcess } from 'child_process';
import dgram from 'dgram';
import http from 'http';
import https from 'https';
import net from 'net';
import { decodeMuLawSample } from './audio-utils';
import { Ds06mGateRelay } from './gate-relay';
import { SipCallSession } from './sip-call-session';
import { SipManager, SipOptions } from './sip-manager';
import { RtpDescription, isStunMessage, getPayloadType, getSequenceNumber, isRtpMessagePayloadType } from './rtp-utils';
import { randomBytes } from "crypto";
import { deviceManager, mediaManager, sdk, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, StorageSettings } from './scrypted-sdk';

const LEGACY_GATE_LOCK_NATIVE_ID = 'ds06m-gate-lock';
const DOORBELL_NAME = 'Домофон';
const DOORBELL_ROOM = 'Улица';
const PLUGIN_VERSION = '0.4.5';
const DOORBELL_INTERFACES = [
    ScryptedInterface.Camera,
    ScryptedInterface.VideoCamera,
    ScryptedInterface.Settings,
    ScryptedInterface.Intercom,
    ScryptedInterface.BinarySensor,
    ScryptedInterface.MotionSensor,
    ScryptedInterface.Lock,
];

class SipCamera extends ScryptedDeviceBase implements Intercom, Camera, VideoCamera, Settings, BinarySensor, MotionSensor, Lock {
    buttonTimeout: NodeJS.Timeout;
    motionTimeout: NodeJS.Timeout;
    callSession: SipCallSession;
    remoteRtpDescription: RtpDescription;
    audioOutForwarder: dgram.Socket;
    audioOutProcess: ChildProcess;
    doorbellAudioActive: boolean;
    audioInProcess: ChildProcess;
    audioSilenceProcess: ChildProcess;
    clientSocket: net.Socket;
    incomingSipManager: SipManager;
    incomingSipOptions: SipOptions;
    pendingInvite: any;
    pendingInviteTimeout: NodeJS.Timeout;
    acceptingIncomingCall: Promise<void>;
    private gateRelay: Ds06mGateRelay;
    private sourceMotionListener?: EventListenerRegister;
    private sourceMotionDetected = false;
    private doorbellMotionDetected = false;

    constructor(nativeId: string, public provider: SipCamProvider) {
        super(nativeId);
        this.binaryState = false;
        this.gateRelay = new Ds06mGateRelay(this);
        this.doorbellAudioActive = false;
        this.audioSilenceProcess = null;
        // The panel always initiates the call. Start listening when Scrypted
        // loads this device, rather than waiting for its separate camera card
        // to be opened.
        void this.ensureIncomingSip().catch(error =>
            this.console.error('SIP: failed to start DS06M listener', error));
    }

    async unlock(): Promise<void> {
        if (!this.gateRelay)
            throw new Error('Gate relay is not enabled for this doorbell');
        await this.gateRelay.unlock();
    }

    async lock(): Promise<void> {
        if (!this.gateRelay)
            throw new Error('Gate relay is not enabled for this doorbell');
        await this.gateRelay.lock();
    }

    async takePicture(option?: PictureOptions): Promise<MediaObject> {
        const sourceCameraId = this.storage.getItem('sourceCameraId');
        const source = sourceCameraId && sdk.systemManager.getDeviceById(sourceCameraId) as unknown as Camera;
        if (!source?.takePicture)
            throw new Error('The configured source camera does not provide snapshots.');
        return source.takePicture(option);
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        const sourceCameraId = this.storage.getItem('sourceCameraId');
        const source = sourceCameraId && sdk.systemManager.getDeviceById(sourceCameraId) as unknown as Camera;
        return source?.getPictureOptions?.();
    }

    storageSettings = new StorageSettings(this, {
        ffmpegInputs: {
            title: 'RTSP Stream URL',
            description: 'An RTSP Stream URL provided by the camera.',
            placeholder: 'rtsp://<DOORBELL_HOST>:554/av0_0',
            multiple: true,
        },
    })

    async getFFmpegInputSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue) {
        if (this.storageSettings.settings[key]) {
            this.storageSettings.putSetting(key, value);
        }
        else if (key === 'defaultStream') {
            const vsos = await this.getVideoStreamOptions();
            const stream = vsos.find(vso => vso.name === value);
            this.storage.setItem('defaultStream', stream?.id || '');
        }
        else {
            this.storage.setItem(key, value.toString());
        }

        if (key === 'sourceCameraId')
            this.refreshSourceMotionSensor();

        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    async getSettings(): Promise<Setting[]> {
        // Older Scrypted releases may retain the previous child descriptor
        // after updating a local plugin. Refresh it when settings are opened.
        await this.provider.updateDevice(this.nativeId, this.name || DOORBELL_NAME);
        return [
            ...(this.gateRelay?.getSettings() || []),
            {
                key: 'sourceCameraId',
                title: 'Source Camera ID',
                value: this.storage.getItem('sourceCameraId'),
                description: 'Scrypted ID of the working ONVIF/RTSP camera. Video and incoming audio are read from this device; SIP is used only for talkback.',
                placeholder: 'device-id',
            },
            {
                key: 'username',
                title: 'Username',
                value: this.storage.getItem('username'),
                description: 'Optional: Username for snapshot http requests.',
            },
            {
                key: 'password',
                title: 'Password',
                value: this.storage.getItem('password'),
                type: 'password',
                description: 'Optional: Password for snapshot http requests.',
            },
            ...await this.getFFmpegInputSettings(),
            {
                key: 'sipfrom',
                title: 'SIP From: URI',
                value: this.storage.getItem('sipfrom'),
                description: 'SIP URI From: field. Host part is the local IP to listen on. Optional local UDP port for SIP signaling can be specified.',
                placeholder: 'scrypted@<SCRYPTED_HOST>:5060',
                multiple: false,
            },
            {
                key: 'sipto',
                title: 'SIP To: URI',
                value: this.storage.getItem('sipto'),
                description: 'SIP URI To: field.',
                placeholder: 'doorbell@<DOORBELL_HOST>:5060',
                multiple: false,
            },
        ];
    }

    async startIntercom(media: MediaObject): Promise<void> {
        this.stopAudioOut();

        const ffmpegInput: FFmpegInput = JSON.parse((await mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput)).toString());
        const audioOutForwarder = await createBindZero();
        this.audioOutForwarder = audioOutForwarder.server;
        let packetCount = 0;
        let byteCount = 0;
        let nonSilenceBytes = 0;
        let minPacketSize = Number.POSITIVE_INFINITY;
        let maxPacketSize = 0;
        let previousTimestamp: number;
        let lastTimestampDelta = 0;
        let voicePackets = 0;
        let activating = false;
        let talkbackReady = false;
        const bufferedPackets: Buffer[] = [];

        const sendToDoorbell = (message: Buffer) => {
            const remoteRtpDescription = this.remoteRtpDescription;
            if (!this.callSession || !remoteRtpDescription?.address || !remoteRtpDescription.audio?.port)
                return;
            this.callSession.audioSplitter.send(message as any, remoteRtpDescription.audio.port, remoteRtpDescription.address);
        };

        const activateTalkback = async () => {
            await this.answerPendingIncomingCall();
            const remoteRtpDescription = this.remoteRtpDescription;
            if (!remoteRtpDescription?.address || !remoteRtpDescription.audio?.port)
                throw new Error('DS06M did not provide a valid RTP audio destination');

            await this.enableDoorbellAudioOutput();
            this.console.log(`Starting DS06M talkback to ${remoteRtpDescription.address}:${remoteRtpDescription.audio.port} after voice detection (PCMU/8000, payload type 0)`);
            const activeSession = this.callSession;
            activeSession.onCallEnded.subscribe(() => {
                closeQuiet(audioOutForwarder.server);
                cp.kill('SIGKILL');
            });
            talkbackReady = true;
            for (const packet of bufferedPackets)
                sendToDoorbell(packet);
            bufferedPackets.length = 0;

            // Some DS06M firmware revisions reset the speaker route while the
            // SIP dialog is transitioning to active. Reassert it after RTP has
            // started as well as immediately after the 200 OK.
            setTimeout(() => {
                if (talkbackReady && this.callSession)
                    void this.enableDoorbellAudioOutput();
            }, 500);
        };

        audioOutForwarder.server.on('message', message => {
            packetCount++;
            byteCount += message.length;
            minPacketSize = Math.min(minPacketSize, message.length);
            maxPacketSize = Math.max(maxPacketSize, message.length);
            if (message.length >= 8) {
                const timestamp = message.readUInt32BE(4);
                if (previousTimestamp !== undefined)
                    lastTimestampDelta = (timestamp - previousTimestamp) >>> 0;
                previousTimestamp = timestamp;
            }
            // PCMU digital silence is normally 0xff (and sometimes 0x7f).
            for (let i = 12; i < message.length; i++) {
                if (message[i] !== 0xff && message[i] !== 0x7f)
                    nonSilenceBytes++;
            }

            let absoluteTotal = 0;
            let peak = 0;
            for (let i = 12; i < message.length; i++) {
                const absolute = Math.abs(decodeMuLawSample(message[i]));
                absoluteTotal += absolute;
                peak = Math.max(peak, absolute);
            }
            const payloadLength = Math.max(1, message.length - 12);
            const average = Math.round(absoluteTotal / payloadLength);

            if (!talkbackReady) {
                bufferedPackets.push(message as any);
                if (bufferedPackets.length > 50)
                    bufferedPackets.shift();

                // HomeKit sends low-level return-audio packets as soon as live
                // view opens. Require sustained speech before answering the
                // pending SIP call, so viewing video alone does not stop the
                // physical ringing on the DS06M.
                if (average >= 600 && peak >= 2500)
                    voicePackets++;
                else
                    voicePackets = Math.max(0, voicePackets - 1);

                if (packetCount === 1 || packetCount === 10 || packetCount % 100 === 0)
                    this.console.log(`DS06M talkback waiting for voice: ${packetCount} packets, level average=${average}, peak=${peak}, sustained=${voicePackets}/8`);

                if (voicePackets >= 8 && !activating) {
                    activating = true;
                    this.console.log(`DS06M talkback voice detected: level average=${average}, peak=${peak}; answering SIP call`);
                    void activateTalkback().catch(error => {
                        this.console.error('DS06M talkback activation failed', error);
                        this.stopAudioOut();
                    });
                }
                return null;
            }

            if (packetCount === 1 || packetCount === 10 || packetCount % 100 === 0)
                this.console.log(`DS06M talkback RTP: ${packetCount} packets, ${byteCount} bytes, ${nonSilenceBytes} non-silence payload bytes, packet size ${minPacketSize}-${maxPacketSize}, timestamp delta ${lastTimestampDelta}, level average=${average}, peak=${peak}`);
            sendToDoorbell(message);
            return null;
        });

        const args = ffmpegInput.inputArguments.slice();
        args.push(
            '-vn', '-dn', '-sn',
            '-acodec', 'pcm_mulaw',
            '-flags', '+global_header',
            '-ac', '1',
            '-ar', '8k',
            // HomeKit supplies Opus at 24/48 kHz. Resample before framing;
            // otherwise asetnsamples=160 creates 26/53-sample PCMU packets
            // after the later 8 kHz conversion instead of 20 ms packets.
            '-af', 'aresample=8000,asetnsamples=n=160:p=1',
            '-payload_type', '0',
            '-f', 'rtp',
            `rtp://127.0.0.1:${audioOutForwarder.port}?pkt_size=172`,
        );

        const cp = child_process.spawn(await mediaManager.getFFmpegPath(), args);
        this.audioOutProcess = cp;
        ffmpegLogInitialOutput(this.console, cp);
        cp.on('exit', (code, signal) => this.console.log(`two way audio ended: code=${code}, signal=${signal}, packets=${packetCount}, bytes=${byteCount}, nonSilence=${nonSilenceBytes}`));
    }

    private async enableDoorbellAudioOutput(): Promise<void> {
        const configuredUrl = this.storage.getItem('openUrl')?.trim();
        if (!configuredUrl) {
            this.console.warn('DS06M audio output activation skipped: relay URL is not configured');
            return;
        }

        try {
            const target = new URL(configuredUrl);
            const username = decodeURIComponent(target.username);
            const password = decodeURIComponent(target.password);
            target.username = '';
            target.password = '';
            target.pathname = '/cgi-bin/audiooutswitch_cgi';
            target.search = 'channel=1';

            const transport = target.protocol === 'https:' ? https : http;
            await new Promise<void>((resolve, reject) => {
                const request = transport.request(target, {
                    method: 'GET',
                    auth: username ? `${username}:${password}` : undefined,
                }, response => {
                    let body = '';
                    response.setEncoding('utf8');
                    response.on('data', chunk => body += chunk);
                    response.on('end', () => {
                        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300 && /OK/i.test(body))
                            resolve();
                        else
                            reject(new Error(`HTTP ${response.statusCode || 'unknown'}`));
                    });
                });
                request.setTimeout(3000, () => request.destroy(new Error('request timed out')));
                request.once('error', reject);
                request.end();
            });
            this.console.log('DS06M audio output channel 1 enabled');
        }
        catch (e) {
            this.console.warn('DS06M audio output activation failed; continuing with SIP RTP', e);
        }
    }

    async ensureIncomingSip(): Promise<void> {
        if (this.incomingSipManager)
            return;
        const from = this.storage.getItem('sipfrom');
        const to = this.storage.getItem('sipto');
        if (!from || !to)
            return;
        const localIp = from.split(':')[0].split('@')[1];
        const localPort = parseInt(from.split(':')[1]) || 5062;
        const sipOptions: SipOptions = {
            from: 'sip:' + from,
            to: 'sip:' + to,
            localIp,
            localPort,
            sipRequestHandler: {
                handle: (request: any) => {
                    if (request.method === 'INVITE')
                        this.queueIncomingCall(request);
                    else if (request.method === 'CANCEL')
                        this.cancelPendingIncomingCall(request);
                },
            } as any,
        };
        this.incomingSipOptions = sipOptions;
        this.incomingSipManager = new SipManager(this.console, sipOptions);
        this.console.log(`SIP: listening for DS06M calls on ${localIp}:${localPort}`);
    }

    private queueIncomingCall(request: any): void {
        if (this.pendingInvite?.headers?.['call-id'] === request.headers?.['call-id']) {
            this.console.debug('SIP: received retransmitted DS06M INVITE while ringing');
            return;
        }
        if (this.callSession || this.pendingInvite) {
            this.console.warn('SIP: rejecting a second incoming DS06M call while another call is active');
            this.incomingSipManager.sendResponse(request, 486, 'Busy Here');
            return;
        }

        this.pendingInvite = request;
        const audioOffer = request.content?.split(/\r?\n/)
            .filter((line: string) => line.startsWith('m=audio') || line.startsWith('a=rtpmap:'))
            .join(', ');
        this.console.log(`SIP: incoming DS06M call is ringing${audioOffer ? `; offer: ${audioOffer}` : ''}`);

        // Notify HomeKit now, but do not answer the SIP call until HomeKit
        // starts the Intercom stream (the user presses Talk).
        this.triggerBinaryState();

        clearTimeout(this.pendingInviteTimeout);
        this.pendingInviteTimeout = setTimeout(() => {
            if (this.pendingInvite !== request)
                return;
            this.console.log('SIP: incoming DS06M call was not answered');
            this.incomingSipManager.sendResponse(request, 480, 'Temporarily Unavailable');
            this.clearPendingIncomingCall();
        }, 120000);
    }

    private cancelPendingIncomingCall(cancelRequest: any): void {
        this.incomingSipManager.sendResponse(cancelRequest, 200, 'Ok');
        if (!this.pendingInvite)
            return;

        this.console.log('SIP: DS06M cancelled the unanswered call');
        this.incomingSipManager.sendResponse(this.pendingInvite, 487, 'Request Terminated');
        this.clearPendingIncomingCall();
    }

    private clearPendingIncomingCall(): void {
        clearTimeout(this.pendingInviteTimeout);
        this.pendingInviteTimeout = undefined;
        this.pendingInvite = undefined;
    }

    private async answerPendingIncomingCall(): Promise<void> {
        if (this.callSession && this.remoteRtpDescription)
            return;
        if (this.acceptingIncomingCall)
            return this.acceptingIncomingCall;
        if (!this.pendingInvite)
            throw new Error('DS06M talkback is available only while the doorbell is ringing');

        const request = this.pendingInvite;
        this.clearPendingIncomingCall();
        this.acceptingIncomingCall = this.acceptIncomingCall(request, this.incomingSipOptions);
        try {
            await this.acceptingIncomingCall;
        }
        finally {
            this.acceptingIncomingCall = undefined;
        }
    }

    private async acceptIncomingCall(request: any, sipOptions: SipOptions): Promise<void> {
        try {
            const session = await SipCallSession.createCallSession(this.console, this.name, sipOptions, this.incomingSipManager);
            this.callSession = session;
            session.onCallEnded.subscribe(() => {
                if (this.callSession === session)
                    this.callSession = undefined;
                this.remoteRtpDescription = undefined;
                void this.stopAudioOut();
            });
            this.remoteRtpDescription = await session.callOrAcceptInvite((audio) => [
                `m=audio ${audio.port} RTP/AVP 0`,
                'a=rtpmap:0 PCMU/8000',
                'a=ptime:20',
                'a=sendrecv',
            ], undefined, request);
            this.console.log('SIP: accepted incoming DS06M call');
        }
        catch (e) {
            this.console.error('SIP: failed to accept DS06M call', e);
            this.callSession = undefined;
        }
    }

    async stopIntercom(): Promise<void> {
        this.stopAudioOut();
        this.stopSession();
    }

    async stopAudioOut(): Promise<void> {
        closeQuiet(this.audioOutForwarder);
        this.audioOutProcess?.kill('SIGKILL');
        this.audioOutProcess = undefined;
        this.audioOutForwarder = undefined;
    }

    stopSession() {
        this.doorbellAudioActive = false;
        this.audioInProcess?.kill('SIGKILL');
        if (this.callSession) {
            this.console.log('ending sip session');
            this.callSession.stop();
            this.callSession = undefined;
        }
    }

    async callDoorbell(): Promise<void> {
        let sip: SipCallSession;

        const cleanup = () => {
            if (this.callSession === sip)
                this.callSession = undefined;
            try {
                this.console.log('stopping sip session.');
                sip.stop();
            }
            catch (e) {
            }
        }

        const from = this.storage.getItem('sipfrom');
        const to = this.storage.getItem('sipto');
        const localIp = from.split(':')[0].split('@')[1];
        const localPort = parseInt(from.split(':')[1]) || 5060;

        if (!from || !to || !localIp || !localPort) {
            this.console.error('SIP From: and To: URIs not specified!');
            return;
        }

        this.console.log(`SIP: Calling doorbell: From: ${from}, To: ${to}`);
        this.console.log(`SIP: localIp: ${localIp}, localPort: ${localPort}`);

        let sipOptions: SipOptions = { from: "sip:" + from, to: "sip:" + to, localIp, localPort };

        sip = await SipCallSession.createCallSession(this.console, this.name, sipOptions);
        sip.onCallEnded.subscribe(cleanup);
        this.remoteRtpDescription = await sip.call(
            ( audio ) => {
                return [
                    `m=audio ${audio.port} RTP/AVP 0`,
                    'a=rtpmap:0 PCMU/8000',
                    'a=ptime:20',
                    'a=sendrecv'
                ]
            }
        );
        this.console.log('SIP: Received remote SDP:\n', this.remoteRtpDescription.sdp)

        let [rtpPort, rtcpPort] = await SipCallSession.reserveRtpRtcpPorts()
        this.console.log(`Reserved RTP port ${rtpPort} and RTCP port ${rtcpPort} for incoming SIP audio`);

        const ffmpegPath = await mediaManager.getFFmpegPath();

        const ffmpegArgs = [
            '-hide_banner',
            '-nostats',
            '-f', 'rtp',
            '-i', `rtp://127.0.0.1:${rtpPort}?listen&localrtcpport=${rtcpPort}`,
            '-acodec', 'copy',
            '-f', 'mulaw',
            'pipe:3'
        ];

        safePrintFFmpegArguments(console, ffmpegArgs);
        const cp = child_process.spawn(ffmpegPath, ffmpegArgs, {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        });
        this.audioInProcess = cp;
        ffmpegLogInitialOutput(console, cp);

        cp.stdout.on('data', data => this.console.log(data.toString()));
        cp.stderr.on('data', data => this.console.log(data.toString()));

        this.doorbellAudioActive = true;
        cp.stdio[3].on('data', data => {
            if (this.doorbellAudioActive && this.clientSocket) {
                this.clientSocket.write(data);
            }
        });

        let aseq = 0;
        let aseen = 0;
        let alost = 0;

        sip.audioSplitter.on('message', message => {
            if (!isStunMessage(message)) {
                const isRtpMessage = isRtpMessagePayloadType(getPayloadType(message));
                if (!isRtpMessage)
                    return;
                aseen++;
                sip.audioSplitter.send(message as any, rtpPort, "127.0.0.1");
                const seq = getSequenceNumber(message);
                if (seq !== (aseq + 1) % 0x0FFFF)
                    alost++;
                aseq = seq;
            }
        });

        sip.audioRtcpSplitter.on('message', message => {
            sip.audioRtcpSplitter.send(message as any, rtcpPort, "127.0.0.1");
        });

        this.callSession = sip;
    }

    getRawVideoStreamOptions(): ResponseMediaStreamOptions[] {
        const ffmpegInputs = this.storageSettings.values.ffmpegInputs as string[];

        // filter out empty strings.
        const ret = ffmpegInputs
            .filter(ffmpegInput => !!ffmpegInput)
            .map((ffmpegInput, index) => this.createFFmpegMediaStreamOptions(ffmpegInput, index));

        if (!ret.length)
            return;
        return ret;

    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        await this.ensureIncomingSip();
        const sourceCameraId = this.storage.getItem('sourceCameraId');
        if (!sourceCameraId)
            throw new Error('Source Camera ID is not configured.');
        const source = sdk.systemManager.getDeviceById(sourceCameraId) as unknown as VideoCamera;
        return source.getVideoStreamOptions();
    }

    getDefaultStream(vsos: ResponseMediaStreamOptions[]) {
        return vsos?.[0];
    }

    async getVideoStream(options?: ResponseMediaStreamOptions): Promise<MediaObject> {
        const sourceCameraId = this.storage.getItem('sourceCameraId');
        if (!sourceCameraId)
            throw new Error('Source Camera ID is not configured.');
        const source = sdk.systemManager.getDeviceById(sourceCameraId) as unknown as VideoCamera;
        return source.getVideoStream(options);
    }


    createFFmpegMediaStreamOptions(ffmpegInput: string, index: number) {
        try {
        }
        catch (e) {
        }

        return {
            id: `channel${index}`,
            name: `Stream ${index + 1}`,
            url: undefined,
            container: '', // must be empty to support prebuffering
            video: {
                codec: 'h264',
                h264Info: {
                    sei: false,
                    stapb: false,
                    mtap16: false,
                    mtap32: false,
                    fuab: false,
                    reserved0: false,
                    reserved30: false,
                    reserved31: false,
                }
            },
            audio: { /*this.isAudioDisabled() ? null : {}, */
                // this is a hint to let homekit, et al, know that it's OPUS audio and does not need transcoding.
                codec: 'pcm_mulaw',
            },
        };
    }

    async startSilenceGenerator() {

        if (this.audioSilenceProcess)
            return;

        const ffmpegPath = await mediaManager.getFFmpegPath();
        const ffmpegArgs = [
            '-hide_banner',
            '-nostats',
            '-re',
            '-f', 'lavfi',
            '-i', 'anullsrc=r=8000:cl=mono',
            '-f', 'mulaw',
            'pipe:3'
        ];

        safePrintFFmpegArguments(console, ffmpegArgs);
        const cp = child_process.spawn(ffmpegPath, ffmpegArgs, {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        });
        this.audioSilenceProcess = cp;
        ffmpegLogInitialOutput(console, cp);

        cp.stdout.on('data', data => this.console.log(data.toString()));
        cp.stderr.on('data', data => this.console.log(data.toString()));
        cp.stdio[3].on('data', data => {
            if (!this.doorbellAudioActive && this.clientSocket) {
                this.clientSocket.write(data);
            }
        });
    }

    stopSilenceGenerator() {
        this.audioSilenceProcess?.kill();
        this.audioSilenceProcess = null;
    }

    async startAudioServer(): Promise<number> {

        const server = net.createServer(async (clientSocket) => {
            clearTimeout(serverTimeout);

            this.clientSocket = clientSocket;

            this.startSilenceGenerator();

            this.clientSocket.on('close', () => {
                this.stopSilenceGenerator();
                this.clientSocket = null;
            });
        });
        const serverTimeout = setTimeout(() => {
            this.console.log('timed out waiting for client');
            server.close();
        }, 30000);
        const port = await listenZero(server);

        return port;
    }

    async createVideoStream(options?: ResponseMediaStreamOptions): Promise<MediaObject> {
        const index = this.getRawVideoStreamOptions()?.findIndex(vso => vso.id === options.id);
        const ffmpegInputs = this.storageSettings.values.ffmpegInputs as string[];
        const ffmpegInput = ffmpegInputs[index];

        if (!ffmpegInput)
            throw new Error('video streams not set up or no longer exists.');

        const port = await this.startAudioServer();

        const ret: FFmpegInput = {
            url: undefined,
            inputArguments: [
                '-analyzeduration', '0',
                '-probesize', '32',
                '-fflags', 'nobuffer',
                '-flags', 'low_delay',
                '-f', 'rtsp',
                '-rtsp_transport', 'tcp',
                '-i', ffmpegInput,
                '-f', 'mulaw',
                '-ac', '1',
                '-ar', '8000',
                '-channel_layout', 'mono',
                '-use_wallclock_as_timestamps', 'true',
                '-i', `tcp://127.0.0.1:${port}?tcp_nodelay=1`,
            ],
            mediaStreamOptions: options,
        };

        return mediaManager.createFFmpegMediaObject(ret);
    }

    triggerBinaryState() {
        this.binaryState = true;
        clearTimeout(this.buttonTimeout);
        this.buttonTimeout = setTimeout(() => this.binaryState = false, 10000);

        // HomeKit Secure Video requires a MotionSensor event to start a
        // recording. A doorbell press is a useful fallback motion event even
        // when the selected source camera does not expose motion detection.
        this.doorbellMotionDetected = true;
        this.updateMotionState();
        clearTimeout(this.motionTimeout);
        this.motionTimeout = setTimeout(() => {
            this.doorbellMotionDetected = false;
            this.updateMotionState();
        }, 15000);
    }

    refreshSourceMotionSensor(): void {
        this.sourceMotionListener?.removeListener();
        this.sourceMotionListener = undefined;
        this.sourceMotionDetected = false;

        const sourceCameraId = this.storage.getItem('sourceCameraId');
        const source = sourceCameraId && sdk.systemManager.getDeviceById(sourceCameraId) as ScryptedDevice & MotionSensor;
        if (!source?.interfaces?.includes(ScryptedInterface.MotionSensor)) {
            this.updateMotionState();
            return;
        }

        this.sourceMotionDetected = !!source.motionDetected;
        this.updateMotionState();
        this.sourceMotionListener = sdk.systemManager.listenDevice(
            sourceCameraId,
            { event: ScryptedInterface.MotionSensor, watch: true },
            eventSource => {
                this.sourceMotionDetected = !!(eventSource as ScryptedDevice & MotionSensor)?.motionDetected;
                this.updateMotionState();
            });
    }

    private updateMotionState(): void {
        this.motionDetected = this.sourceMotionDetected || this.doorbellMotionDetected;
    }
}

export class SipCamProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, MixinProvider {

    devices = new Map<string, SipCamera>();

    constructor(nativeId?: string) {
        super(nativeId);
        this.systemDevice = {
            deviceCreator: 'SIP Camera',
        };
        for (const camId of deviceManager.getNativeIds()) {
            if (!camId)
                continue;
            if (camId === LEGACY_GATE_LOCK_NATIVE_ID) {
                void deviceManager.onDeviceRemoved(camId);
                continue;
            }
            const state = deviceManager.getDeviceState(camId);
            const currentName = sdk.systemManager.getDeviceById(state.id)?.name;
            const name = !currentName || currentName === 'DS06M SIP Bridge'
                ? DOORBELL_NAME
                : currentName;
            // Register new interfaces before constructing the device. Setting a
            // MotionSensor property before Scrypted knows that interface causes
            // older installations to reject the device instance and retain the
            // previous descriptor.
            void this.updateDevice(camId, name)
                .then(() => this.getDevice(camId))
                .catch(error => this.console.error('Failed to refresh DS06M descriptor', error));
        }
    }



    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = randomBytes(4).toString('hex');
        // Older Scrypted management consoles can invoke this action without
        // serializing the form value. Keep device creation recoverable.
        const name = settings?.newCamera?.toString()?.trim() || DOORBELL_NAME;
        await this.updateDevice(nativeId, name);
        return nativeId;
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'newCamera',
                title: 'Add Camera',
                placeholder: 'Camera name, e.g.: Back Yard Camera, Baby Camera, etc',
            }
        ]
    }

    updateDevice(nativeId: string, name: string) {
        return deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            room: DOORBELL_ROOM,
            info: {
                manufacturer: 'BEWARD',
                model: 'DS06M',
                version: PLUGIN_VERSION,
            },
            interfaces: [...DOORBELL_INTERFACES],
            type: ScryptedDeviceType.Doorbell,
        });
    }

    async getDevice(nativeId: string): Promise<SipCamera> {
        let ret = this.devices.get(nativeId);
        if (!ret) {
            ret = this.createCamera(nativeId);
            if (ret) {
                this.devices.set(nativeId, ret);
                // Refresh the descriptor whenever Scrypted asks the provider
                // to recreate a child after a plugin or server update.
                void this.updateDevice(nativeId, DOORBELL_NAME)
                    .then(() => ret.refreshSourceMotionSensor())
                    .catch(error => this.console.error('Failed to initialize DS06M motion sensor', error));
            }
        }
        return ret;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        if( this.devices.delete( nativeId ) ) {
            this.console.log("Removed device from list: " + id + " / " + nativeId )
        }
    }

    createCamera(nativeId: string): SipCamera {
        return new SipCamera(nativeId, this);
    }

    getConfiguredBridge(): SipCamera {
        const devices = [...this.devices.values()] as SipCamera[];
        const configured = devices.find(device =>
            device.storage.getItem('sipfrom') && device.storage.getItem('sipto'));
        const bridge = configured || devices[0];
        if (!bridge)
            throw new Error('Create and configure a BEWARD DS06M device before enabling the intercom mixin');
        return bridge;
    }

    async canMixin(type: ScryptedDeviceTypeValue, interfaces: string[]): Promise<string[]> {
        if ((type !== ScryptedDeviceType.Camera && type !== ScryptedDeviceType.Doorbell)
            || !interfaces.includes(ScryptedInterface.VideoCamera)
            || interfaces.includes(ScryptedInterface.Intercom))
            return;
        return [ScryptedInterface.Intercom];
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterfaceValue[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new Ds06mIntercomMixin(this);
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
    }
}

class Ds06mIntercomMixin implements Intercom {
    constructor(private provider: SipCamProvider) {
    }

    private getBridge(): SipCamera {
        // The configured bridge owns the SIP settings. Keeping them in one place
        // makes this mixin safe across plugin updates and avoids copying secrets.
        return this.provider.getConfiguredBridge();
    }

    async startIntercom(media: MediaObject): Promise<void> {
        return this.getBridge().startIntercom(media);
    }

    async stopIntercom(): Promise<void> {
        return this.getBridge().stopIntercom();
    }
}

export default new SipCamProvider();

// Global variables
let localStream;
let isScreenSharing = false;
let isMuted = false;
let isCameraOff = false;
let meetingStartTime;
let participants = new Map();
let currentUser;
let deviceType = detectDeviceType();
let isGoogleStreamingMode = false;

// Device detection for better compatibility
function detectDeviceType() {
    const userAgent = navigator.userAgent;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    const isTablet = /(iPad|Android(?!.*Mobile))/i.test(userAgent);
    
    return {
        isMobile,
        isTablet,
        isDesktop: !isMobile && !isTablet,
        isIOS: /iPad|iPhone|iPod/.test(userAgent),
        isAndroid: /Android/i.test(userAgent),
        supportsGetDisplayMedia: navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices
    };
}

// DOM elements
const preJoinScreen = document.getElementById('preJoinScreen');
const meetingScreen = document.getElementById('meetingScreen');
const joinButton = document.getElementById('joinButton');
const leaveButton = document.getElementById('leaveButton');
const muteButton = document.getElementById('muteButton');
const videoButton = document.getElementById('videoButton');
const screenShareButton = document.getElementById('screenShareButton');
const nameInput = document.getElementById('nameInput');
const previewVideo = document.getElementById('previewVideo');
const videoGrid = document.getElementById('videoGrid');
const participantCount = document.getElementById('participantCount');
const meetingTime = document.getElementById('meetingTime');
const sharedContent = document.getElementById('sharedContent');
const sharedScreen = document.getElementById('sharedScreen');

// SOCKET.IO variables
const socket = io();
const roomId = 'video-meeting-room';
let peerConnections = {};
let iceCandidatesQueue = {}; // Queue for ICE candidates received before remote description


// Initialize the app
async function initializeApp() {
    try {
        console.log('Initializing video chat app...');
        // Start preview video
        await startPreview();
        initializeSocketConnection();     // Initialize socket connection after preview
    } catch (error) {
        console.error('Failed to initialize app:', error);
    }
}

// Start camera preview before joining
async function startPreview() {
    try {
        const constraints = getOptimalMediaConstraints();
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        previewVideo.srcObject = stream;
        localStream = stream;
        console.log('Camera preview started with constraints:', constraints);
        console.log('Stream tracks:', stream.getTracks().map(t => ({ kind: t.kind, settings: t.getSettings() })));
    } catch (error) {
        console.error('Failed to access camera:', error);
        // Show placeholder if camera access fails
        previewVideo.style.display = 'none';
        const placeholder = document.createElement('div');
        placeholder.className = 'video-placeholder';
        placeholder.textContent = 'Camera not available';
        previewVideo.parentNode.appendChild(placeholder);
    }
}

// Get optimal media constraints based on device type and capabilities
function getOptimalMediaConstraints() {
    const baseConstraints = {
        video: {
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: 'user'
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1
        }
    };

    // Optimize for mobile devices
    if (deviceType.isMobile) {
        baseConstraints.video.width = { ideal: 480, max: 640 };
        baseConstraints.video.height = { ideal: 360, max: 480 };
        baseConstraints.video.frameRate = { ideal: 24, max: 30 };
        
        // Mobile-specific audio optimizations
        baseConstraints.audio.sampleRate = 44100;
        baseConstraints.audio.latency = 0.01; // Low latency for better sync
    }

    // Optimize for tablets
    if (deviceType.isTablet) {
        baseConstraints.video.width = { ideal: 640, max: 960 };
        baseConstraints.video.height = { ideal: 480, max: 540 };
    }

    // Desktop optimizations for Google streaming
    if (deviceType.isDesktop) {
        baseConstraints.video.width = { ideal: 960, max: 1280 };
        baseConstraints.video.height = { ideal: 540, max: 720 };
        baseConstraints.video.frameRate = { ideal: 30, max: 60 };
        
        // Higher quality audio for desktop
        baseConstraints.audio.sampleRate = 48000;
        baseConstraints.audio.channelCount = 2;
    }

    return baseConstraints;
}

// Initialize Socket.IO connection
function initializeSocketConnection() {
    socket.on('user-connected', (userId, userName) => {
        console.log(`User ${userName} connected`);
        addParticipant(userId, userName, false);
        // New user joined, we create the offer (we are the initiator)
        createPeerConnection(userId, true);
        updateParticipantCount();
    });
    
    socket.on('existing-users', (users) => {
        users.forEach(user => {
            addParticipant(user.userId, user.userName, false);
            // These are existing users, they will create offers to us
            createPeerConnection(user.userId, false);
        });
        updateParticipantCount();
    });
    
    socket.on('user-disconnected', (userId) => {
        console.log(`User ${userId} disconnected`);
        if (peerConnections[userId]) {
            peerConnections[userId].close();
            delete peerConnections[userId];
        }
        removeParticipant(userId);
        updateParticipantCount();
    });
    
    socket.on('offer', async (offer, fromUserId) => {
        try {
            console.log(`Received offer from ${fromUserId}`);
            const pc = createPeerConnection(fromUserId, false);
            
            if (pc.signalingState !== 'stable') {
                console.log(`Peer connection not in stable state: ${pc.signalingState}`);
                return;
            }
            
            await pc.setRemoteDescription(offer);
            
            // Process any queued ICE candidates
            await processQueuedIceCandidates(fromUserId);
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('answer', answer, fromUserId);
        } catch (error) {
            console.error(`Error handling offer from ${fromUserId}:`, error);
        }
    });
    
    socket.on('answer', async (answer, fromUserId) => {
        try {
            console.log(`Received answer from ${fromUserId}`);
            const pc = peerConnections[fromUserId];
            if (pc && pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(answer);
                
                // Process any queued ICE candidates
                await processQueuedIceCandidates(fromUserId);
            } else {
                console.log(`Ignoring answer from ${fromUserId}, wrong state: ${pc ? pc.signalingState : 'no connection'}`);
            }
        } catch (error) {
            console.error(`Error handling answer from ${fromUserId}:`, error);
        }
    });
    
    socket.on('ice-candidate', async (candidate, fromUserId) => {
        try {
            console.log(`Received ICE candidate from ${fromUserId}`);
            const pc = peerConnections[fromUserId];
            if (pc && pc.remoteDescription) {
                await pc.addIceCandidate(candidate);
                console.log(` Added ICE candidate from ${fromUserId}`);
            } else {
                console.log(` Queuing ICE candidate from ${fromUserId} (remote description not ready)`);
                // Queue the candidate for later
                if (!iceCandidatesQueue[fromUserId]) {
                    iceCandidatesQueue[fromUserId] = [];
                }
                iceCandidatesQueue[fromUserId].push(candidate);
            }
        } catch (error) {
            console.error(`Error handling ICE candidate from ${fromUserId}:`, error);
        }
    });
    
    socket.on('user-toggle-audio', (userId, isMuted) => {
        updateRemoteUserStatus(userId, 'audio', isMuted);
    });
    
    socket.on('user-toggle-video', (userId, isVideoOff) => {
        updateRemoteUserStatus(userId, 'video', isVideoOff);
    });
    
    socket.on('screen-share-started', (userId) => {
        console.log(`User ${userId} started screen sharing`);
        addScreenShareIndicator(userId);
    });
    
    socket.on('screen-share-stopped', (userId) => {
        console.log(`User ${userId} stopped screen sharing`);
        removeScreenShareIndicator(userId);
    });
}

// Create WebRTC peer connection
function createPeerConnection(userId, isInitiator = false) {
    if (peerConnections[userId]) {
        return peerConnections[userId];
    }
    
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    });
    
    // Add local stream to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            console.log(`Adding ${track.kind} track to peer connection for ${userId}`);
            pc.addTrack(track, localStream);
        });
    }
    
// Handle remote stream
    pc.ontrack = (event) => {
        console.log(`Received remote ${event.track.kind} track from ${userId}:`, event);
        const participantElement = document.querySelector(`#participant-${userId}`);
        const remoteVideo = participantElement?.querySelector('video');
        
        if (remoteVideo && event.streams[0]) {
            console.log(`Setting stream for ${userId}:`, event.streams[0]);
            
            // Remove any existing click-to-play buttons
            const existingPlayButton = participantElement.querySelector('.play-button');
            if (existingPlayButton) {
                existingPlayButton.remove();
            }
            
            // Remove loading indicator
            const loadingIndicator = participantElement.querySelector('.loading-indicator');
            if (loadingIndicator) {
                loadingIndicator.remove();
            }
            
            // Handle multiple streams or track additions
            if (remoteVideo.srcObject) {
                // Stream already exists, add tracks to existing stream
                const existingStream = remoteVideo.srcObject;
                const newTracks = event.streams[0].getTracks();
                
                newTracks.forEach(track => {
                    const existingTrack = existingStream.getTracks().find(t => t.kind === track.kind);
                    if (existingTrack) {
                        existingStream.removeTrack(existingTrack);
                    }
                    existingStream.addTrack(track);
                });
                
                console.log(`Updated existing stream for ${userId}`);
            } else {
                // Set new stream
                remoteVideo.srcObject = event.streams[0];
            }
            
            remoteVideo.style.display = 'block';
            remoteVideo.style.opacity = '1';
            remoteVideo.style.background = 'transparent';
            
            // Essential video properties for proper playback
            remoteVideo.muted = false; // Allow remote audio to be heard
            remoteVideo.autoplay = true;
            remoteVideo.playsInline = true;
            remoteVideo.controls = false;
            
            // Force video to start playing with comprehensive error handling
            const tryPlay = async () => {
                try {
                    // Ensure video is ready
                    if (remoteVideo.readyState < 2) {
                        await new Promise(resolve => {
                            remoteVideo.addEventListener('loadeddata', resolve, { once: true });
                        });
                    }
                    
                    await remoteVideo.play();
                    console.log(` Video playing successfully for ${userId}`);
                    hideParticipantAvatar(userId);
                    showConnectionStatus(userId, 'connected');
                    
                    // Enable video visibility
                    remoteVideo.style.opacity = '1';
                    
                } catch (error) {
                    console.log(`Autoplay failed for ${userId}:`, error.message);
                    
                    // Try again with user interaction
                    if (error.name === 'NotAllowedError') {
                        addClickToPlay(remoteVideo, userId);
                    } else {
                        // For other errors, try again after a delay
                        setTimeout(tryPlay, 1000);
                    }
                }
            };
            
            // Multiple attempts to start video
            setTimeout(tryPlay, 100);
            
            // Try again when metadata loads
            remoteVideo.addEventListener('loadedmetadata', () => {
                console.log(`Video metadata loaded for ${userId}`);
                setTimeout(tryPlay, 50);
            }, { once: true });
            
            // Try again when data loads
            remoteVideo.addEventListener('loadeddata', () => {
                console.log(`Video data loaded for ${userId}`);
                setTimeout(tryPlay, 50);
            }, { once: true });
            
            // Handle track events
            event.track.addEventListener('ended', () => {
                console.log(`${event.track.kind} track ended for ${userId}`);
                if (event.track.kind === 'video') {
                    showParticipantAvatar(userId);
                }
            });
            
            // Handle track mute/unmute
            event.track.addEventListener('mute', () => {
                console.log(`${event.track.kind} track muted for ${userId}`);
                if (event.track.kind === 'video') {
                    remoteVideo.style.opacity = '0.3';
                }
            });
            
            event.track.addEventListener('unmute', () => {
                console.log(`${event.track.kind} track unmuted for ${userId}`);
                if (event.track.kind === 'video') {
                    remoteVideo.style.opacity = '1';
                    tryPlay();
                }
            });
            
            console.log(` Video stream successfully set for ${userId}`);
        } else {
            console.warn(`Could not set video stream for ${userId}:`, {
                remoteVideo: !!remoteVideo,
                stream: !!event.streams[0],
                participantElement: !!participantElement
            });
        }
    };
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`Sending ICE candidate to ${userId}`);
            socket.emit('ice-candidate', event.candidate, userId);
        }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${userId}: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
            console.log(` Successfully connected to ${userId}`);
        } else if (pc.connectionState === 'failed') {
            console.log(`Connection failed with ${userId}`);
            // Don't automatically restart, let user handle it
        }
    };
    
    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with ${userId}: ${pc.iceConnectionState}`);
    };
    
    peerConnections[userId] = pc;
    
    // Only create offer if we're the initiator
    if (isInitiator && currentUser) {
        setTimeout(() => createOffer(userId), 100); // Small delay to ensure everything is set up
    }
    
    return pc;
}

// Create and send offer
async function createOffer(userId) {
    try {
        const pc = peerConnections[userId];
        if (pc) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('offer', offer, userId);
        }
    } catch (error) {
        console.error('Error creating offer:', error);
    }
}

// Process queued ICE candidates
async function processQueuedIceCandidates(userId) {
    const pc = peerConnections[userId];
    const queuedCandidates = iceCandidatesQueue[userId];
    
    if (pc && pc.remoteDescription && queuedCandidates && queuedCandidates.length > 0) {
        console.log(` Processing ${queuedCandidates.length} queued ICE candidates for ${userId}`);
        
        for (const candidate of queuedCandidates) {
            try {
                await pc.addIceCandidate(candidate);
                console.log(` Added queued ICE candidate for ${userId}`);
            } catch (error) {
                console.error(` Failed to add queued ICE candidate for ${userId}:`, error);
            }
        }
        
        // Clear the queue
        delete iceCandidatesQueue[userId];
        console.log(` Processed all queued ICE candidates for ${userId}`);
    }
}

// Update remote user status
function updateRemoteUserStatus(userId, type, isDisabled) {
    const participantElement = participants.get(userId);
    if (participantElement) {
        const statusContainer = participantElement.querySelector('.video-status');
        
        if (type === 'audio' && isDisabled) {
            // Add mute indicator
            let muteIcon = statusContainer.querySelector('.audio-muted');
            if (!muteIcon) {
                muteIcon = document.createElement('div');
                muteIcon.className = 'status-icon muted audio-muted';
                muteIcon.innerHTML = '<span class="material-icons">mic_off</span>';
                statusContainer.appendChild(muteIcon);
            }
        } else if (type === 'audio' && !isDisabled) {
            // Remove mute indicator
            const muteIcon = statusContainer.querySelector('.audio-muted');
            if (muteIcon) {
                muteIcon.remove();
            }
        }
        
        if (type === 'video') {
            const video = participantElement.querySelector('video');
            if (video) {
                video.style.opacity = isDisabled ? '0' : '1';
            }
        }
    }
}

// Join the meeting
async function joinMeeting() {
    try {
        const userName = nameInput.value.trim() || 'Guest User';
        
        // Create user
        currentUser = {
            id: 'user-' + Math.random().toString(36).substring(7),
            name: userName
        };
        
        // Get fresh media stream for the meeting
        if (!localStream || !localStream.active) {
            localStream = await navigator.mediaDevices.getUserMedia({ 
                video: true, 
                audio: true 
            });
        }
        
        // Switch to meeting screen
        preJoinScreen.style.display = 'none';
        meetingScreen.style.display = 'block';
        
        // Start meeting timer
        meetingStartTime = new Date();
        startMeetingTimer();
        
        // Add local participant
        addParticipant(currentUser.id, currentUser.name, true);
        
        // Join the room via Socket.IO
        socket.emit('join-room', roomId, currentUser.id, currentUser.name);
        
        // Update participant count
        updateParticipantCount();
        
        console.log('Successfully joined meeting');
        
    } catch (error) {
        console.error('Failed to join meeting:', error);
        alert('Failed to join meeting. Please check camera/microphone permissions.');
    }
}


// Add participant to the grid
function addParticipant(participantId, participantName, isLocal = false) {
    const participantElement = document.createElement('div');
    participantElement.className = 'video-tile';
    participantElement.id = `participant-${participantId}`;
    
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = isLocal; // Only mute local video to prevent feedback, allow remote audio
    video.playsInline = true;
    video.controls = false;
    
    // Additional properties for better video handling
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    
    const nameLabel = document.createElement('div');
    nameLabel.className = 'participant-name';
    nameLabel.textContent = isLocal ? `${participantName} (You)` : participantName;
    
    const statusContainer = document.createElement('div');
    statusContainer.className = 'video-status';
    
    // Add mute indicator if needed
    if (isLocal && isMuted) {
        const muteIcon = document.createElement('div');
        muteIcon.className = 'status-icon muted';
        muteIcon.innerHTML = '<span class="material-icons">mic_off</span>';
        statusContainer.appendChild(muteIcon);
    }
    
    participantElement.appendChild(video);
    participantElement.appendChild(nameLabel);
    participantElement.appendChild(statusContainer);
    
    // Add click listener for fullscreen
    participantElement.addEventListener('click', () => toggleFullscreen(participantElement));
    
    videoGrid.appendChild(participantElement);
    participants.set(participantId, participantElement);
    
    // Set up local video stream
    if (isLocal && localStream) {
        video.srcObject = localStream;
    } else if (!isLocal) {
        // Create placeholder for remote participants
        video.style.background = `linear-gradient(45deg, hsl(${Math.random() * 360}, 70%, 50%), hsl(${Math.random() * 360}, 70%, 30%))`;
        video.style.display = 'block'; // Show video element immediately
        video.style.opacity = '0.3'; // Make it slightly transparent until stream arrives
        
        // Add an avatar that will be hidden when video stream starts
        const avatar = document.createElement('div');
        avatar.className = 'participant-avatar';
        avatar.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: linear-gradient(45deg, hsl(${Math.random() * 360}, 70%, 50%), hsl(${Math.random() * 360}, 70%, 30%));
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            font-weight: bold;
            color: white;
            z-index: 2;
        `;
        avatar.textContent = participantName.charAt(0).toUpperCase();
        participantElement.appendChild(avatar);
        
        // Add loading indicator for remote participants
        addLoadingIndicator(participantId);
    }
    
    updateVideoGrid();
}

// Remove participant from grid
function removeParticipant(participantId) {
    const participantElement = participants.get(participantId);
    if (participantElement) {
        participantElement.remove();
        participants.delete(participantId);
        updateVideoGrid();
    }
}

// Update video grid layout based on participant count
function updateVideoGrid() {
    const participantCount = participants.size;
    
    // Reset all classes
    videoGrid.className = 'video-grid';
    
    // Apply appropriate layout class based on participant count
    switch (participantCount) {
        case 1:
            videoGrid.classList.add('single-video');
            break;
        case 2:
            videoGrid.classList.add('two-videos');
            break;
        case 3:
            videoGrid.classList.add('three-videos');
            break;
        case 4:
            videoGrid.classList.add('four-videos');
            break;
        case 5:
            videoGrid.classList.add('five-videos');
            break;
        case 6:
            videoGrid.classList.add('six-videos');
            break;
        case 7:
        case 8:
            videoGrid.classList.add('seven-videos');
            break;
        case 9:
            videoGrid.classList.add('nine-videos');
            break;
        default:
            videoGrid.classList.add('many-videos');
            break;
    }
    
    console.log(`Updated video grid for ${participantCount} participants`);
}

// Toggle fullscreen for video
function toggleFullscreen(element) {
    if (element.classList.contains('fullscreen-video')) {
        element.classList.remove('fullscreen-video');
        document.body.style.overflow = 'hidden';
    } else {
        // Remove fullscreen from other videos
        document.querySelectorAll('.fullscreen-video').forEach(el => {
            el.classList.remove('fullscreen-video');
        });
        element.classList.add('fullscreen-video');
        
        // Click anywhere to exit fullscreen after a delay
        setTimeout(() => {
            const exitFullscreen = (e) => {
                if (e.target === element || element.contains(e.target)) return;
                element.classList.remove('fullscreen-video');
                document.removeEventListener('click', exitFullscreen);
            };
            document.addEventListener('click', exitFullscreen);
        }, 100);
    }
}

// Toggle microphone
async function toggleMicrophone() {
    try {
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                isMuted = !audioTrack.enabled;
                
                if (isMuted) {
                    muteButton.classList.add('muted');
                    muteButton.querySelector('.material-icons').textContent = 'mic_off';
                } else {
                    muteButton.classList.remove('muted');
                    muteButton.querySelector('.material-icons').textContent = 'mic';
                }
                
                // Update status indicator on local video
                updateLocalVideoStatus();
                
                // Notify other participants
                socket.emit('toggle-audio', isMuted);
            }
        }
    } catch (error) {
        console.error('Failed to toggle microphone:', error);
    }
}

// Toggle camera
async function toggleCamera() {
    try {
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                isCameraOff = !videoTrack.enabled;
                
                if (isCameraOff) {
                    videoButton.classList.add('muted');
                    videoButton.querySelector('.material-icons').textContent = 'videocam_off';
                } else {
                    videoButton.classList.remove('muted');
                    videoButton.querySelector('.material-icons').textContent = 'videocam';
                }
                
                // Update local video display
                const localVideo = document.querySelector('#participant-' + currentUser.id + ' video');
                if (localVideo) {
                    localVideo.style.opacity = isCameraOff ? '0' : '1';
                }
                
                // Notify other participants
                socket.emit('toggle-video', isCameraOff);
            }
        }
    } catch (error) {
        console.error('Failed to toggle camera:', error);
    }
}

// Update local video status indicators
function updateLocalVideoStatus() {
    const localParticipant = participants.get(currentUser.id);
    if (localParticipant) {
        const statusContainer = localParticipant.querySelector('.video-status');
        statusContainer.innerHTML = '';
        
        if (isMuted) {
            const muteIcon = document.createElement('div');
            muteIcon.className = 'status-icon muted';
            muteIcon.innerHTML = '<span class="material-icons">mic_off</span>';
            statusContainer.appendChild(muteIcon);
        }
    }
}

// Add screen sharing indicator
function addScreenShareIndicator(userId) {
    const participantElement = participants.get(userId);
    if (participantElement) {
        const nameLabel = participantElement.querySelector('.participant-name');
        const statusContainer = participantElement.querySelector('.video-status');
        
        // Update name label to show screen sharing
        const originalName = nameLabel.textContent.replace(' (Sharing screen)', '');
        nameLabel.textContent = originalName + ' (Sharing screen)';
        
        // Add screen share icon
        let screenIcon = statusContainer.querySelector('.screen-sharing');
        if (!screenIcon) {
            screenIcon = document.createElement('div');
            screenIcon.className = 'status-icon screen-sharing';
            screenIcon.innerHTML = '<span class="material-icons">screen_share</span>';
            screenIcon.style.background = '#1a73e8';
            statusContainer.appendChild(screenIcon);
        }
        
        console.log(`Added screen sharing indicator for ${userId}`);
    }
}

// Remove screen sharing indicator
function removeScreenShareIndicator(userId) {
    const participantElement = participants.get(userId);
    if (participantElement) {
        const nameLabel = participantElement.querySelector('.participant-name');
        const statusContainer = participantElement.querySelector('.video-status');
        
        // Remove screen sharing text from name
        nameLabel.textContent = nameLabel.textContent.replace(' (Sharing screen)', '');
        
        // Remove screen share icon
        const screenIcon = statusContainer.querySelector('.screen-sharing');
        if (screenIcon) {
            screenIcon.remove();
        }
        
        console.log(`Removed screen sharing indicator for ${userId}`);
    }
}

// Toggle screen sharing
async function toggleScreenShare() {
    try {
        if (isScreenSharing) {
            // Stop screen sharing and return to camera
            await stopScreenShare();
        } else {
            // Start screen sharing
            await startScreenShare();
        }
    } catch (error) {
        console.error('Failed to toggle screen share:', error);
        if (error.name === 'NotAllowedError') {
            alert('Screen sharing permission denied. Please allow screen sharing and try again.');
        }
    }
}

// Start screen sharing
async function startScreenShare() {
    try {
        // Get screen capture stream
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                mediaSource: 'screen',
                width: { ideal: 1920, max: 1920 },
                height: { ideal: 1080, max: 1080 },
                frameRate: { ideal: 30, max: 60 }
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                sampleRate: 44100
            }
        });
        
        console.log('Screen capture stream obtained:', screenStream);
        
        // Update UI
        screenShareButton.classList.add('active');
        screenShareButton.querySelector('.material-icons').textContent = 'stop_screen_share';
        isScreenSharing = true;
        
        // Get tracks from screen stream
        const videoTrack = screenStream.getVideoTracks()[0];
        const audioTrack = screenStream.getAudioTracks()[0];
        
        console.log('Screen sharing tracks:', {
            video: !!videoTrack,
            audio: !!audioTrack,
            videoSettings: videoTrack?.getSettings(),
            audioSettings: audioTrack?.getSettings()
        });
        
        // Store original camera stream for later restoration
        window.originalStream = localStream;
        
        // Create new stream with screen tracks
        const combinedStream = new MediaStream();
        
        // Add video track from screen
        if (videoTrack) {
            combinedStream.addTrack(videoTrack);
        }
        
        // Add audio - prefer screen audio, fallback to microphone
        if (audioTrack) {
            combinedStream.addTrack(audioTrack);
            console.log('Using screen audio');
        } else if (localStream && localStream.getAudioTracks()[0]) {
            combinedStream.addTrack(localStream.getAudioTracks()[0]);
            console.log('Using microphone audio');
        }
        
        // Replace tracks in all peer connections with better error handling
        const trackReplacementPromises = [];
        
        for (const [userId, pc] of Object.entries(peerConnections)) {
            console.log(`Replacing tracks for user ${userId}`);
            
            const senders = pc.getSenders();
            console.log(`Found ${senders.length} senders for ${userId}`);
            
            // Replace video track
            const videoSender = senders.find(sender => 
                sender.track && sender.track.kind === 'video'
            );
            
            if (videoSender && videoTrack) {
                const replaceVideoPromise = videoSender.replaceTrack(videoTrack)
                    .then(() => {
                        console.log(` Successfully replaced video track for ${userId}`);
                    })
                    .catch(error => {
                        console.error(` Failed to replace video track for ${userId}:`, error);
                        // Try to re-add the track
                        return pc.addTrack(videoTrack, combinedStream)
                            .then(() => console.log(` Re-added video track for ${userId}`))
                            .catch(e => console.error(` Failed to re-add video track for ${userId}:`, e));
                    });
                trackReplacementPromises.push(replaceVideoPromise);
            } else {
                console.warn(`No video sender found for ${userId}`);
                // Add track if sender doesn't exist
                if (videoTrack) {
                    try {
                        pc.addTrack(videoTrack, combinedStream);
                        console.log(` Added new video track for ${userId}`);
                    } catch (error) {
                        console.error(` Failed to add video track for ${userId}:`, error);
                    }
                }
            }
            
            // Replace audio track if we have screen audio
            if (audioTrack) {
                const audioSender = senders.find(sender => 
                    sender.track && sender.track.kind === 'audio'
                );
                
                if (audioSender) {
                    const replaceAudioPromise = audioSender.replaceTrack(audioTrack)
                        .then(() => {
                            console.log(` Successfully replaced audio track for ${userId}`);
                        })
                        .catch(error => {
                            console.error(` Failed to replace audio track for ${userId}:`, error);
                        });
                    trackReplacementPromises.push(replaceAudioPromise);
                }
            }
        }
        
        // Wait for all track replacements to complete
        try {
            await Promise.allSettled(trackReplacementPromises);
            console.log(' All track replacements completed');
        } catch (error) {
            console.error(' Some track replacements failed:', error);
        }
        
        // Update local video display with screen share
        const localVideo = document.querySelector(`#participant-${currentUser.id} video`);
        if (localVideo) {
            localVideo.srcObject = combinedStream;
            console.log(' Updated local video display with screen share');
            
            // Ensure local video plays
            try {
                await localVideo.play();
            } catch (error) {
                console.warn('Local video autoplay failed:', error);
            }
        }
        
        // Update local stream reference
        localStream = combinedStream;
        
        // Notify other participants that screen sharing started
        socket.emit('screen-share-started', currentUser.id);
        
        console.log(' Screen sharing started and transmitted to all peers');
        
        // Listen for screen share end (when user clicks "Stop sharing" in browser)
        videoTrack.addEventListener('ended', () => {
            console.log('Screen share ended by user (browser stop sharing)');
            stopScreenShare();
        });
        
        // Also listen for track becoming inactive
        videoTrack.addEventListener('mute', () => {
            console.log('Screen share video track muted');
        });
        
        if (audioTrack) {
            audioTrack.addEventListener('ended', () => {
                console.log('Screen share audio ended');
            });
        }
        
    } catch (error) {
        console.error(' Failed to start screen share:', error);
        
        // Reset UI state on failure
        screenShareButton.classList.remove('active');
        screenShareButton.querySelector('.material-icons').textContent = 'screen_share';
        isScreenSharing = false;
        
        throw error;
    }
}

// Stop screen sharing and return to camera
async function stopScreenShare() {
    try {
        // Update UI
        screenShareButton.classList.remove('active');
        screenShareButton.querySelector('.material-icons').textContent = 'screen_share';
        isScreenSharing = false;
        
        // Get camera stream back
        const cameraStream = window.originalStream || await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        
        // Replace screen share tracks back to camera tracks in all peer connections
        for (const [userId, pc] of Object.entries(peerConnections)) {
            const senders = pc.getSenders();
            
            // Replace video track back to camera
            const videoSender = senders.find(sender => 
                sender.track && sender.track.kind === 'video'
            );
            if (videoSender) {
                const cameraVideoTrack = cameraStream.getVideoTracks()[0];
                await videoSender.replaceTrack(cameraVideoTrack);
                console.log(`Restored camera video track for ${userId}`);
            }
            
            // Replace audio track back to microphone
            const audioSender = senders.find(sender => 
                sender.track && sender.track.kind === 'audio'
            );
            if (audioSender) {
                const cameraAudioTrack = cameraStream.getAudioTracks()[0];
                await audioSender.replaceTrack(cameraAudioTrack);
                console.log(`Restored microphone audio track for ${userId}`);
            }
        }
        
        // Update local video display back to camera
        const localVideo = document.querySelector(`#participant-${currentUser.id} video`);
        if (localVideo) {
            localVideo.srcObject = cameraStream;
        }
        
        // Update local stream reference
        localStream = cameraStream;
        
        // Notify other participants that screen sharing stopped
        socket.emit('screen-share-stopped', currentUser.id);
        
        console.log('Screen sharing stopped, returned to camera');
        
    } catch (error) {
        console.error('Failed to stop screen share:', error);
        throw error;
    }
}

// Leave meeting
async function leaveMeeting() {
    try {
        // Clean up
        participants.clear();
        videoGrid.innerHTML = '';
        
        // Stop all media streams
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        
        // Reset UI
        meetingScreen.style.display = 'none';
        preJoinScreen.style.display = 'flex';
        sharedContent.style.display = 'none';
        
        // Reset button states
        muteButton.classList.remove('muted');
        videoButton.classList.remove('muted');
        screenShareButton.classList.remove('active');
        muteButton.querySelector('.material-icons').textContent = 'mic';
        videoButton.querySelector('.material-icons').textContent = 'videocam';
        screenShareButton.querySelector('.material-icons').textContent = 'screen_share';
        
        // Reset variables
        isMuted = false;
        isCameraOff = false;
        isScreenSharing = false;
        meetingStartTime = null;
        
        // Restart preview
        await startPreview();
        
        console.log('Left meeting successfully');
    } catch (error) {
        console.error('Failed to leave meeting:', error);
    }
}

// Update participant count display
function updateParticipantCount() {
    const count = participants.size;
    participantCount.textContent = `${count} participant${count !== 1 ? 's' : ''}`;
}

// Start meeting timer
function startMeetingTimer() {
    const timerInterval = setInterval(() => {
        if (meetingStartTime) {
            const elapsed = new Date() - meetingStartTime;
            const minutes = Math.floor(elapsed / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);
            meetingTime.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            clearInterval(timerInterval);
        }
    }, 1000);
}

// Event listeners
joinButton.addEventListener('click', joinMeeting);
leaveButton.addEventListener('click', leaveMeeting);
muteButton.addEventListener('click', toggleMicrophone);
videoButton.addEventListener('click', toggleCamera);
screenShareButton.addEventListener('click', toggleScreenShare);

// Allow joining with Enter key
nameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        joinMeeting();
    }
});

// Helper functions for better video connection handling

// Show connection status for a participant
function showConnectionStatus(userId, status) {
    const participantElement = document.querySelector(`#participant-${userId}`);
    if (participantElement) {
        // Remove existing status indicators
        const existingStatus = participantElement.querySelector('.connection-status');
        if (existingStatus) {
            existingStatus.remove();
        }
        
        if (status === 'connected') {
            // Add a brief success indicator
            const statusIndicator = document.createElement('div');
            statusIndicator.className = 'connection-status connected';
            statusIndicator.innerHTML = '✅';
            statusIndicator.style.cssText = `
                position: absolute;
                top: 8px;
                left: 8px;
                background: rgba(34, 139, 34, 0.9);
                color: white;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 12px;
                z-index: 3;
                animation: fadeInOut 3s ease forwards;
            `;
            participantElement.appendChild(statusIndicator);
            
            // Auto-remove after 3 seconds
            setTimeout(() => {
                if (statusIndicator.parentNode) {
                    statusIndicator.remove();
                }
            }, 3000);
        }
    }
}

// Hide participant avatar when video is working
function hideParticipantAvatar(userId) {
    const participantElement = document.querySelector(`#participant-${userId}`);
    if (participantElement) {
        const avatar = participantElement.querySelector('.participant-avatar');
        if (avatar) {
            avatar.style.display = 'none';
        }
    }
}

// Show participant avatar when video is not working
function showParticipantAvatar(userId) {
    const participantElement = document.querySelector(`#participant-${userId}`);
    if (participantElement) {
        const avatar = participantElement.querySelector('.participant-avatar');
        if (avatar) {
            avatar.style.display = 'flex';
        }
    }
}

// Add click to play functionality for videos that can't autoplay
function addClickToPlay(videoElement, userId) {
    const playButton = document.createElement('div');
    playButton.className = 'play-button';
    playButton.innerHTML = '▶️ Click to play video';
    playButton.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 16px;
        border-radius: 8px;
        cursor: pointer;
        z-index: 4;
        font-size: 14px;
        font-weight: 500;
        text-align: center;
    `;
    
    const participantElement = document.querySelector(`#participant-${userId}`);
    if (participantElement) {
        participantElement.appendChild(playButton);
        
        playButton.addEventListener('click', async () => {
            try {
                await videoElement.play();
                playButton.remove();
                hideParticipantAvatar(userId);
                console.log(`Video manually started for ${userId}`);
            } catch (error) {
                console.error('Failed to play video manually:', error);
            }
        });
    }
}

// Add loading indicator for connecting participants
function addLoadingIndicator(userId) {
    const participantElement = document.querySelector(`#participant-${userId}`);
    if (participantElement) {
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'loading-indicator';
        loadingIndicator.innerHTML = '⏳ Connecting...';
        loadingIndicator.style.cssText = `
            position: absolute;
            top: 12px;
            left: 12px;
            background: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            z-index: 3;
        `;
        participantElement.appendChild(loadingIndicator);
    }
}

// Enhanced Google streaming compatibility functions

// Create composite stream for Google Meet/streaming integration
function createCompositeStream() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Set canvas dimensions based on device type
    if (deviceType.isMobile) {
        canvas.width = 640;
        canvas.height = 480;
    } else if (deviceType.isTablet) {
        canvas.width = 960;
        canvas.height = 540;
    } else {
        canvas.width = 1280;
        canvas.height = 720;
    }
    
    console.log(`Created composite canvas: ${canvas.width}x${canvas.height}`);
    
    // Function to draw all participants on canvas
    function drawComposite() {
        ctx.fillStyle = '#202124';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const participantVideos = Array.from(participants.entries()).map(([id, element]) => {
            const video = element.querySelector('video');
            return { id, video, element };
        }).filter(p => p.video && p.video.videoWidth > 0);
        
        if (participantVideos.length === 0) {
            // Show waiting message
            ctx.fillStyle = '#ffffff';
            ctx.font = '24px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Waiting for participants...', canvas.width / 2, canvas.height / 2);
            return;
        }
        
        // Calculate grid layout
        const cols = Math.ceil(Math.sqrt(participantVideos.length));
        const rows = Math.ceil(participantVideos.length / cols);
        const cellWidth = canvas.width / cols;
        const cellHeight = canvas.height / rows;
        
        participantVideos.forEach((participant, index) => {
            const { video, element } = participant;
            const col = index % cols;
            const row = Math.floor(index / cols);
            const x = col * cellWidth;
            const y = row * cellHeight;
            
            try {
                // Draw video with proper aspect ratio
                const aspectRatio = video.videoWidth / video.videoHeight;
                let drawWidth = cellWidth;
                let drawHeight = cellHeight;
                let drawX = x;
                let drawY = y;
                
                if (aspectRatio > cellWidth / cellHeight) {
                    drawHeight = cellWidth / aspectRatio;
                    drawY = y + (cellHeight - drawHeight) / 2;
                } else {
                    drawWidth = cellHeight * aspectRatio;
                    drawX = x + (cellWidth - drawWidth) / 2;
                }
                
                ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
                
                // Draw participant name
                const nameLabel = element.querySelector('.participant-name');
                if (nameLabel) {
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                    ctx.fillRect(x + 10, y + cellHeight - 30, nameLabel.textContent.length * 8 + 20, 20);
                    ctx.fillStyle = '#ffffff';
                    ctx.font = '14px Arial';
                    ctx.textAlign = 'left';
                    ctx.fillText(nameLabel.textContent, x + 20, y + cellHeight - 15);
                }
                
                // Draw mute indicator if muted
                const muteIcon = element.querySelector('.audio-muted');
                if (muteIcon) {
                    ctx.fillStyle = '#ea4335';
                    ctx.beginPath();
                    ctx.arc(x + cellWidth - 20, y + 20, 8, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.fillStyle = '#ffffff';
                    ctx.font = '12px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText('🔇', x + cellWidth - 20, y + 25);
                }
                
            } catch (error) {
                console.warn(`Failed to draw participant ${participant.id}:`, error);
                // Draw placeholder
                ctx.fillStyle = '#3c4043';
                ctx.fillRect(x, y, cellWidth, cellHeight);
                ctx.fillStyle = '#ffffff';
                ctx.font = '16px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('Video Loading...', x + cellWidth / 2, y + cellHeight / 2);
            }
        });
    }
    
    // Start animation loop for composite stream
    let animationId;
    function animate() {
        drawComposite();
        animationId = requestAnimationFrame(animate);
    }
    animate();
    
    // Create stream from canvas
    const compositeStream = canvas.captureStream(30); // 30 FPS
    
    // Add audio from all participants (mixed)
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const destination = audioContext.createMediaStreamDestination();
    
    // Mix audio from all participants
    participants.forEach((element, id) => {
        const video = element.querySelector('video');
        if (video && video.srcObject) {
            const audioTracks = video.srcObject.getAudioTracks();
            if (audioTracks.length > 0) {
                const source = audioContext.createMediaStreamSource(video.srcObject);
                source.connect(destination);
            }
        }
    });
    
    // Add mixed audio to composite stream
    destination.stream.getAudioTracks().forEach(track => {
        compositeStream.addTrack(track);
    });
    
    return {
        stream: compositeStream,
        canvas,
        stop: () => {
            if (animationId) {
                cancelAnimationFrame(animationId);
            }
            compositeStream.getTracks().forEach(track => track.stop());
            audioContext.close();
        }
    };
}

// Enable Google streaming mode
function enableGoogleStreamingMode() {
    isGoogleStreamingMode = true;
    
    // Add a composite stream button
    const compositeButton = document.createElement('button');
    compositeButton.id = 'compositeButton';
    compositeButton.className = 'control-btn';
    compositeButton.title = 'Create composite stream for Google Meet';
    compositeButton.innerHTML = '<span class="material-icons">view_comfy</span>';
    
    const controlButtons = document.querySelector('.control-buttons');
    controlButtons.insertBefore(compositeButton, document.getElementById('leaveButton'));
    
    let compositeStreamData = null;
    
    compositeButton.addEventListener('click', async () => {
        try {
            if (compositeStreamData) {
                // Stop composite stream
                compositeStreamData.stop();
                compositeStreamData = null;
                compositeButton.classList.remove('active');
                compositeButton.title = 'Create composite stream for Google Meet';
                console.log('Composite stream stopped');
            } else {
                // Start composite stream
                compositeStreamData = createCompositeStream();
                compositeButton.classList.add('active');
                compositeButton.title = 'Stop composite stream';
                
                // Show instructions to user
                showCompositeStreamInstructions(compositeStreamData.canvas);
                console.log('Composite stream created and ready for Google Meet');
            }
        } catch (error) {
            console.error('Failed to toggle composite stream:', error);
            alert('Failed to create composite stream. Please try again.');
        }
    });
    
    console.log('Google streaming mode enabled');
}

// Show instructions for using composite stream with Google Meet
function showCompositeStreamInstructions(canvas) {
    const modal = document.createElement('div');
    modal.className = 'composite-instructions-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <h3>Composite Stream Ready! </h3>
            <p>Your video chat is now optimized for Google Meet sharing:</p>
            <ol>
                <li>Open Google Meet in a new tab</li>
                <li>Click "Share screen" in Google Meet</li>
                <li>Select "Chrome Tab" and choose this tab</li>
                <li>All participants will be visible in a single view</li>
            </ol>
            <div class="canvas-preview">
                <p><strong>Preview:</strong></p>
                <div id="canvasPreview"></div>
            </div>
            <button id="closeInstructions" class="join-btn">Got it!</button>
        </div>
    `;
    
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;
    
    const modalContent = modal.querySelector('.modal-content');
    modalContent.style.cssText = `
        background: white;
        padding: 30px;
        border-radius: 12px;
        max-width: 500px;
        width: 90%;
        text-align: center;
        color: #202124;
    `;
    
    const canvasPreview = modal.querySelector('#canvasPreview');
    const previewCanvas = canvas.cloneNode();
    previewCanvas.style.cssText = `
        width: 100%;
        max-width: 400px;
        height: auto;
        border: 2px solid #1a73e8;
        border-radius: 8px;
        margin: 10px 0;
    `;
    canvasPreview.appendChild(previewCanvas);
    
    document.body.appendChild(modal);
    
    modal.querySelector('#closeInstructions').addEventListener('click', () => {
        modal.remove();
    });
    
    // Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// Optimize video elements for better streaming performance
function optimizeForStreaming() {
    // Enable hardware acceleration where possible
    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
        video.style.willChange = 'transform';
        video.style.backfaceVisibility = 'hidden';
        video.style.perspective = '1000px';
        
        // Ensure consistent playback
        video.addEventListener('loadedmetadata', () => {
            if (video.readyState >= 2) {
                video.play().catch(e => console.log('Video play failed:', e));
            }
        });
    });
    
    // Optimize video grid for streaming
    videoGrid.style.willChange = 'transform';
    videoGrid.style.backfaceVisibility = 'hidden';
}

// Enhanced video quality monitoring
function monitorVideoQuality() {
    setInterval(() => {
        participants.forEach((element, userId) => {
            const video = element.querySelector('video');
            if (video && video.srcObject) {
                const stream = video.srcObject;
                const videoTracks = stream.getVideoTracks();
                if (videoTracks.length > 0) {
                    const track = videoTracks[0];
                    const settings = track.getSettings();
                    
                    // Log quality metrics for debugging
                    if (settings.width && settings.height) {
                        console.log(` ${userId} video quality: ${settings.width}x${settings.height} @ ${settings.frameRate || 'unknown'}fps`);
                    }
                    
                    // Check if video is playing
                    if (video.readyState >= 2 && !video.paused) {
                        // Video is playing well
                        video.style.filter = 'none';
                    } else {
                        // Video might have issues
                        video.style.filter = 'grayscale(0.3)';
                    }
                }
            }
        });
    }, 5000); // Check every 5 seconds
}

// Initialize the app when page loads
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    
    // Enable Google streaming optimizations
    setTimeout(() => {
        enableGoogleStreamingMode();
        optimizeForStreaming();
        monitorVideoQuality();
    }, 1000);
    
    // Log device information for debugging
    console.log('🔍 Device Information:', {
        type: deviceType,
        userAgent: navigator.userAgent,
        screenResolution: `${screen.width}x${screen.height}`,
        viewportSize: `${window.innerWidth}x${window.innerHeight}`,
        connection: navigator.connection?.effectiveType || 'unknown'
    });
});

// Global variables
let localStream;
let isScreenSharing = false;
let isMuted = false;
let isCameraOff = false;
let meetingStartTime;
let participants = new Map();
let currentUser;

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
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: true 
        });
        previewVideo.srcObject = stream;
        localStream = stream;
        console.log('Camera preview started');
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
            } else {
                console.log(`Queuing ICE candidate from ${fromUserId} (remote description not ready)`);
                // You could implement queuing here if needed
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
        console.log(`Received remote ${event.track.kind} track from ${userId}`);
        const remoteVideo = document.querySelector(`#participant-${userId} video`);
        if (remoteVideo && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            remoteVideo.style.display = 'block';
            remoteVideo.style.opacity = '1';
            
            // Hide avatar when video starts
            const participantElement = document.querySelector(`#participant-${userId}`);
            if (participantElement) {
                const avatar = participantElement.querySelector('div[style*="position: absolute"]');
                if (avatar) {
                    avatar.style.display = 'none';
                }
            }
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
            console.log(`✅ Successfully connected to ${userId}`);
        } else if (pc.connectionState === 'failed') {
            console.log(`❌ Connection failed with ${userId}`);
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
    video.muted = isLocal; // Mute local video to prevent feedback
    video.playsInline = true;
    
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
    
    videoGrid.className = 'video-grid';
    
    if (participantCount === 1) {
        videoGrid.classList.add('single-video');
    } else if (participantCount === 2) {
        videoGrid.classList.add('two-videos');
    } else if (participantCount === 3) {
        videoGrid.classList.add('three-videos');
    } else if (participantCount === 4) {
        videoGrid.classList.add('four-videos');
    } else {
        videoGrid.classList.add('many-videos');
    }
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

// Toggle screen sharing
async function toggleScreenShare() {
    try {
        if (isScreenSharing) {
            // Stop screen sharing
            screenShareButton.classList.remove('active');
            screenShareButton.querySelector('.material-icons').textContent = 'screen_share';
            sharedContent.style.display = 'none';
            isScreenSharing = false;
            console.log('Screen sharing stopped');
        } else {
            // Start screen sharing
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });
            
            screenShareButton.classList.add('active');
            screenShareButton.querySelector('.material-icons').textContent = 'stop_screen_share';
            
            // Show shared screen overlay
            sharedContent.style.display = 'flex';
            
            // Set up screen share video element
            const screenVideo = document.createElement('video');
            screenVideo.autoplay = true;
            screenVideo.playsInline = true;
            screenVideo.srcObject = screenStream;
            sharedScreen.innerHTML = '';
            sharedScreen.appendChild(screenVideo);
            
            isScreenSharing = true;
            console.log('Screen sharing started');
            
            // Listen for screen share end
            screenStream.getVideoTracks()[0].addEventListener('ended', () => {
                toggleScreenShare();
            });
        }
    } catch (error) {
        console.error('Failed to toggle screen share:', error);
        if (error.name === 'NotAllowedError') {
            alert('Screen sharing permission denied. Please allow screen sharing and try again.');
        }
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

// Initialize the app when page loads
document.addEventListener('DOMContentLoaded', initializeApp);

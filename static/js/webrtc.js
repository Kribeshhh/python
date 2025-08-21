let localStream;
let remoteStream;
let peerConnection;
let socket;
let room;
let username;

const servers = {
    iceServers: [
        {
            urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302']
        }
    ]
};

const constraints = {
    video: {
        width: { min: 640, ideal: 1280, max: 1920 },
        height: { min: 480, ideal: 720, max: 1080 }
    },
    audio: true
};

function initWebRTC(roomId, userName) {
    room = roomId;
    username = userName;
    
    // Connect to Socket.IO
    socket = io();
    
    // Set up event listeners
    setupSocketListeners();
    setupMediaControls();
    
    // Initialize media and join room
    initMedia().then(() => {
        handleRoomJoin();
    });
}

function handleRoomJoin() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    
    if (roomParam) {
        // We're joining an existing room
        socket.emit('join_room', { room: roomParam, username: username });
    } else {
        // We're creating a new room
        // This shouldn't happen with our new routing, but just in case
        window.location.href = '/create_room';
    }
}

function setupSocketListeners() {
    socket.on('user_joined', (data) => {
        addMessage('System', `${data.username} joined the call`);
        updateUserList(data.users);
        
        if (data.username !== username) {
            createOffer();
        }
    });
    
    socket.on('user_left', (data) => {
        addMessage('System', `${data.username} left the call`);
        updateUserList(data.users);
        
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    });
    
    socket.on('webrtc_offer', async (data) => {
        if (data.username !== username) {
            await createAnswer(data.offer);
        }
    });
    
    socket.on('webrtc_answer', async (data) => {
        if (data.username !== username) {
            await handleAnswer(data.answer);
        }
    });
    
    socket.on('ice_candidate', async (data) => {
        if (data.username !== username) {
            try {
                await peerConnection.addIceCandidate(data.candidate);
            } catch (error) {
                console.error('Error adding ice candidate:', error);
            }
        }
    });
    
    socket.on('receive_message', (data) => {
        addMessage(data.username, data.message);
    });
    
    socket.on('message_history', (data) => {
        data.messages.forEach(msg => {
            addMessage(msg.username, msg.message);
        });
    });
}

function setupMediaControls() {
    // Toggle video
    document.getElementById('toggleVideo').addEventListener('click', () => {
        if (localStream) {
            const videoTracks = localStream.getVideoTracks();
            if (videoTracks.length > 0) {
                const enabled = videoTracks[0].enabled;
                videoTracks[0].enabled = !enabled;
                document.getElementById('toggleVideo').textContent = enabled ? 'Camera On' : 'Camera Off';
            }
        }
    });
    
    // Toggle audio
    document.getElementById('toggleAudio').addEventListener('click', () => {
        if (localStream) {
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length > 0) {
                const enabled = audioTracks[0].enabled;
                audioTracks[0].enabled = !enabled;
                document.getElementById('toggleAudio').textContent = enabled ? 'Unmute' : 'Mute';
            }
        }
    });
    
    // Share screen
    document.getElementById('shareScreen').addEventListener('click', async () => {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const videoTrack = screenStream.getVideoTracks()[0];
            
            if (localStream) {
                const sender = peerConnection.getSenders().find(s => 
                    s.track && s.track.kind === 'video'
                );
                
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
                
                // Replace the local video track
                const currentVideoTrack = localStream.getVideoTracks()[0];
                localStream.removeTrack(currentVideoTrack);
                localStream.addTrack(videoTrack);
                
                // Handle when the user stops sharing the screen
                videoTrack.onended = async () => {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    const newVideoTrack = stream.getVideoTracks()[0];
                    
                    if (sender) {
                        sender.replaceTrack(newVideoTrack);
                    }
                    
                    localStream.removeTrack(videoTrack);
                    localStream.addTrack(newVideoTrack);
                };
            }
        } catch (error) {
            console.error('Error sharing screen:', error);
        }
    });
    
    // End call
    document.getElementById('endCall').addEventListener('click', () => {
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        
        socket.emit('leave_room', { room: room, username: username });
        window.location.href = '/dashboard';
    });
    
    // Send message
    document.getElementById('sendMessage').addEventListener('click', sendMessage);
    document.getElementById('chatInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });
}

async function initMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        document.getElementById('localVideo').srcObject = localStream;
    } catch (error) {
        console.error('Error accessing media devices:', error);
        alert('Could not access your camera and microphone. Please check permissions.');
    }
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(servers);
    
    remoteStream = new MediaStream();
    document.getElementById('remoteVideo').srcObject = remoteStream;
    
    // Add local stream tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
    
    // Receive remote stream tracks
    peerConnection.ontrack = (event) => {
        event.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });
    };
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice_candidate', {
                room: room,
                candidate: event.candidate
            });
        }
    };
    
    return peerConnection;
}

async function createOffer() {
    peerConnection = createPeerConnection();
    
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('webrtc_offer', {
            room: room,
            offer: offer
        });
    } catch (error) {
        console.error('Error creating offer:', error);
    }
}

async function createAnswer(offer) {
    peerConnection = createPeerConnection();
    
    try {
        await peerConnection.setRemoteDescription(offer);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('webrtc_answer', {
            room: room,
            answer: answer
        });
    } catch (error) {
        console.error('Error creating answer:', error);
    }
}

async function handleAnswer(answer) {
    try {
        await peerConnection.setRemoteDescription(answer);
    } catch (error) {
        console.error('Error handling answer:', error);
    }
}

function sendMessage() {
    const messageInput = document.getElementById('chatInput');
    const message = messageInput.value.trim();
    
    if (message && socket) {
        const timestamp = new Date().toISOString();
        socket.emit('send_message', {
            room: room,
            message: message,
            timestamp: timestamp
        });
        
        addMessage(username, message);
        messageInput.value = '';
    }
}

function addMessage(sender, message) {
    const chatMessages = document.getElementById('chatMessages');
    const messageElement = document.createElement('div');
    messageElement.classList.add('message');
    
    const timestamp = new Date().toLocaleTimeString();
    messageElement.innerHTML = `
        <strong>${sender}:</strong> ${message} 
        <small class="text-muted">${timestamp}</small>
    `;
    
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateUserList(users) {
    // You can implement a user list display if needed
    console.log('Users in room:', users);
}
import React, { useEffect, useRef, useState } from 'react'
import io from "socket.io-client";
import { Badge, IconButton, TextField } from '@mui/material';
import { Button } from '@mui/material';
import VideocamIcon from '@mui/icons-material/Videocam';
import VideocamOffIcon from '@mui/icons-material/VideocamOff'
import styles from "../styles/videoComponent.module.css"; // Ensure this path is correct
import CallEndIcon from '@mui/icons-material/CallEnd'
import MicIcon from '@mui/icons-material/Mic'
import MicOffIcon from '@mui/icons-material/MicOff'
import ScreenShareIcon from '@mui/icons-material/ScreenShare';
import StopScreenShareIcon from '@mui/icons-material/StopScreenShare'
import ChatIcon from '@mui/icons-material/Chat'
import server from '../environment'; // Ensure this path is correct

const server_url = server;

var connections = {}; // Stores RTCPeerConnection objects for each peer

const peerConfigConnections = {
    "iceServers": [
        { "urls": "stun:stun.l.google.com:19302" } // Google's public STUN server
    ]
}

export default function VideoMeetComponent() {

    // Refs for Socket.IO instance and current socket ID
    var socketRef = useRef();
    let socketIdRef = useRef();

    // Ref for the local user's video element
    let localVideoref = useRef();

    // State variables for media availability and control
    let [videoAvailable, setVideoAvailable] = useState(false); // Permission status for video
    let [audioAvailable, setAudioAvailable] = useState(false); // Permission status for audio
    let [video, setVideo] = useState(true); // Current state of local video (on/off)
    let [audio, setAudio] = useState(true); // Current state of local audio (on/off)
    let [screen, setScreen] = useState(false); // Current state of screen sharing (on/off)
    let [screenAvailable, setScreenAvailable] = useState(false); // Permission status for screen share

    // State variables for chat functionality
    let [showModal, setModal] = useState(false); // Controls chat modal visibility
    let [messages, setMessages] = useState([]); // Stores chat messages
    let [message, setMessage] = useState(""); // Current message being typed
    let [newMessages, setNewMessages] = useState(0); // Counter for unread messages

    // State variables for user authentication/lobby
    let [askForUsername, setAskForUsername] = useState(true); // Controls lobby screen visibility
    let [username, setUsername] = useState(""); // User's chosen username

    // Ref and state for managing remote video elements
    const videoRef = useRef([]); // A mutable ref to keep track of video elements
    let [videos, setVideos] = useState([]); // Array of remote video objects {socketId, stream}

    // Effect hook to get initial media permissions on component mount
    useEffect(() => {
        console.log("Component mounted, getting permissions...");
        getPermissions();
    }, []); // Empty dependency array means this runs once on mount

    // Function to get display media (screen sharing)
    let getDislayMedia = () => {
        if (screen && screenAvailable) { // Only attempt if screen sharing is enabled and available
            navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
                .then(getDislayMediaSuccess)
                .catch((e) => console.log("Error getting display media:", e));
        } else if (!screen) { // If screen share is being turned off
            // Revert to user media (camera/mic) if screen share is stopped
            getUserMedia();
        }
    };

    // Function to request camera and microphone permissions
    const getPermissions = async () => {
        try {
            // Request video permission
            const videoPermissionStream = await navigator.mediaDevices.getUserMedia({ video: true });
            if (videoPermissionStream) {
                setVideoAvailable(true);
                videoPermissionStream.getTracks().forEach(track => track.stop()); // Stop tracks immediately after checking
                console.log('Video permission granted');
            } else {
                setVideoAvailable(false);
                console.log('Video permission denied');
            }

            // Request audio permission
            const audioPermissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (audioPermissionStream) {
                setAudioAvailable(true);
                audioPermissionStream.getTracks().forEach(track => track.stop()); // Stop tracks immediately after checking
                console.log('Audio permission granted');
            } else {
                setAudioAvailable(false);
                console.log('Audio permission denied');
            }

            // Check for display media availability
            if (navigator.mediaDevices.getDisplayMedia) {
                setScreenAvailable(true);
            } else {
                setScreenAvailable(false);
            }

            // Get initial user media for the lobby preview
            if (videoAvailable || audioAvailable) {
                const userMediaStream = await navigator.mediaDevices.getUserMedia({ video: videoAvailable, audio: audioAvailable });
                if (userMediaStream) {
                    window.localStream = userMediaStream;
                    if (localVideoref.current) {
                        localVideoref.current.srcObject = userMediaStream;
                    }
                }
            }
        } catch (error) {
            console.log("Error during permission check:", error);
            // If permissions are denied, set availability to false
            setVideoAvailable(false);
            setAudioAvailable(false);
        }
    };

    // Effect hook to trigger getUserMedia when video/audio states change (after initial setup)
    useEffect(() => {
        // Only call getUserMedia if not in the username lobby and states are defined
        if (!askForUsername && (video !== undefined || audio !== undefined)) {
            getUserMedia();
        }
    }, [video, audio, askForUsername]); // Dependencies: video, audio, and askForUsername

    // Effect hook to trigger getDisplayMedia when screen state changes
    useEffect(() => {
        if (screen !== undefined && !askForUsername) {
            getDislayMedia();
        }
    }, [screen, askForUsername]);

    // Function to initiate media acquisition and socket connection after username is entered
    let getMedia = () => {
        // Set initial video/audio state based on permissions
        setVideo(videoAvailable);
        setAudio(audioAvailable);
        connectToSocketServer();
    }

    // Callback for successful getUserMedia (camera/mic) stream acquisition
    let getUserMediaSuccess = (stream) => {
        try {
            // Stop existing tracks from previous streams if any
            if (window.localStream) {
                window.localStream.getTracks().forEach(track => track.stop());
            }
        } catch (e) { console.log("Error stopping old local stream tracks:", e); }

        window.localStream = stream;
        if (localVideoref.current) {
            localVideoref.current.srcObject = stream;
        }

        // Update all existing peer connections with the new local stream
        for (let id in connections) {
            if (id === socketIdRef.current) continue;

            // Remove old tracks and add new ones to peer connections
            // Using getSenders and removeTrack/addTrack for proper stream replacement
            connections[id].getSenders().forEach(sender => {
                if (sender.track) {
                    connections[id].removeTrack(sender);
                }
            });
            stream.getTracks().forEach(track => {
                connections[id].addTrack(track, stream);
            });

            // Re-negotiate the SDP if stream content has changed significantly
            connections[id].createOffer().then((description) => {
                connections[id].setLocalDescription(description)
                    .then(() => {
                        socketRef.current.emit('signal', id, JSON.stringify({ 'sdp': connections[id].localDescription }));
                    })
                    .catch(e => console.log("Error setting local description for offer:", e));
            }).catch(e => console.log("Error creating offer:", e));
        }

        // Listen for when local stream tracks end (e.g., camera unplugged, permission revoked)
        stream.getTracks().forEach(track => track.onended = () => {
            if (track.kind === 'video') setVideo(false);
            if (track.kind === 'audio') setAudio(false);
            if (screen) setScreen(false); // If screen share was active, turn it off

            try {
                if (localVideoref.current && localVideoref.current.srcObject) {
                    localVideoref.current.srcObject.getTracks().forEach(t => t.stop());
                }
            } catch (e) { console.log("Error stopping local stream on track end:", e); }

            // Replace with black video and silent audio
            let blackSilence = (...args) => new MediaStream([black(...args), silence()]);
            window.localStream = blackSilence();
            if (localVideoref.current) {
                localVideoref.current.srcObject = window.localStream;
            }

            // Update peer connections with the black/silent stream
            for (let id in connections) {
                connections[id].getSenders().forEach(sender => {
                    if (sender.track) {
                        connections[id].removeTrack(sender);
                    }
                });
                window.localStream.getTracks().forEach(t => {
                    connections[id].addTrack(t, window.localStream);
                });

                connections[id].createOffer().then((description) => {
                    connections[id].setLocalDescription(description)
                        .then(() => {
                            socketRef.current.emit('signal', id, JSON.stringify({ 'sdp': connections[id].localDescription }));
                        })
                        .catch(e => console.log("Error setting local description on track end offer:", e));
                }).catch(e => console.log("Error creating offer on track end:", e));
            }
        });
    }

    // Function to get user media (camera/mic) based on current state
    let getUserMedia = () => {
        if ((video && videoAvailable) || (audio && audioAvailable)) {
            navigator.mediaDevices.getUserMedia({ video: video, audio: audio })
                .then(getUserMediaSuccess)
                .catch((e) => {
                    console.log("Error getting user media:", e);
                    // Fallback to black/silent if media access fails
                    getUserMediaSuccess(new MediaStream([black(), silence()]));
                });
        } else {
            // If both video and audio are off, stop existing tracks and provide black/silence
            try {
                if (window.localStream) {
                    window.localStream.getTracks().forEach(track => track.stop());
                }
            } catch (e) { console.log("Error stopping tracks when both video/audio are off:", e); }

            let blackSilence = (...args) => new MediaStream([black(...args), silence()]);
            window.localStream = blackSilence();
            if (localVideoref.current) {
                localVideoref.current.srcObject = window.localStream;
            }

            // Update peer connections with the silent/black stream
            for (let id in connections) {
                connections[id].getSenders().forEach(sender => {
                    if (sender.track) {
                        connections[id].removeTrack(sender);
                    }
                });
                window.localStream.getTracks().forEach(track => {
                    connections[id].addTrack(track, window.localStream);
                });
                connections[id].createOffer().then((description) => {
                    connections[id].setLocalDescription(description)
                        .then(() => {
                            socketRef.current.emit('signal', id, JSON.stringify({ 'sdp': connections[id].localDescription }));
                        })
                        .catch(e => console.log("Error setting local description for black/silent offer:", e));
                }).catch(e => console.log("Error creating offer for black/silent:", e));
            }
        }
    }

    // Callback for successful getDisplayMedia (screen share) stream acquisition
    let getDislayMediaSuccess = (stream) => {
        console.log("Screen share stream obtained.");
        try {
            // Stop existing local stream tracks (camera/mic) before replacing with screen share
            if (window.localStream) {
                window.localStream.getTracks().forEach(track => track.stop());
            }
        } catch (e) { console.log("Error stopping old local stream tracks for screen share:", e); }

        window.localStream = stream;
        if (localVideoref.current) {
            localVideoref.current.srcObject = stream;
        }

        // Update all existing peer connections with the screen share stream
        for (let id in connections) {
            if (id === socketIdRef.current) continue;

            // Replace existing video track with screen share video track
            const videoSender = connections[id].getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender) {
                videoSender.replaceTrack(stream.getVideoTracks()[0]);
            } else {
                connections[id].addTrack(stream.getVideoTracks()[0], stream);
            }

            // If screen share includes audio, replace existing audio track
            if (stream.getAudioTracks().length > 0) {
                const audioSender = connections[id].getSenders().find(s => s.track && s.track.kind === 'audio');
                if (audioSender) {
                    audioSender.replaceTrack(stream.getAudioTracks()[0]);
                } else {
                    connections[id].addTrack(stream.getAudioTracks()[0], stream);
                }
            } else {
                // If screen share has no audio, ensure we send a silent audio track
                const audioSender = connections[id].getSenders().find(s => s.track && s.track.kind === 'audio');
                if (audioSender) {
                    audioSender.replaceTrack(silence());
                } else {
                    connections[id].addTrack(silence(), new MediaStream([silence()]));
                }
            }

            // Re-negotiate SDP to inform peers about track changes
            connections[id].createOffer().then((description) => {
                connections[id].setLocalDescription(description)
                    .then(() => {
                        socketRef.current.emit('signal', id, JSON.stringify({ 'sdp': connections[id].localDescription }));
                    })
                    .catch(e => console.log("Error setting local description for screen share offer:", e));
            }).catch(e => console.log("Error creating offer for screen share:", e));
        }

        // Listen for when screen share stream ends (e.g., user stops sharing from browser controls)
        stream.getTracks().forEach(track => track.onended = () => {
            setScreen(false); // Update state to reflect screen share has stopped

            try {
                if (localVideoref.current && localVideoref.current.srcObject) {
                    localVideoref.current.srcObject.getTracks().forEach(t => t.stop());
                }
            } catch (e) { console.log("Error stopping local stream on screen share end:", e); }

            // Revert to user media (camera/mic) when screen share stops
            getUserMedia();
        });
    }

    // Handles incoming signaling messages (SDP offers/answers, ICE candidates) from the server
    let gotMessageFromServer = (fromId, message) => {
        var signal = JSON.parse(message);

        if (fromId !== socketIdRef.current) {
            if (signal.sdp) {
                connections[fromId].setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(() => {
                    if (signal.sdp.type === 'offer') {
                        connections[fromId].createAnswer().then((description) => {
                            connections[fromId].setLocalDescription(description).then(() => {
                                socketRef.current.emit('signal', fromId, JSON.stringify({ 'sdp': connections[fromId].localDescription }));
                            }).catch(e => console.log("Error setting local description for answer:", e));
                        }).catch(e => console.log("Error creating answer:", e));
                    }
                }).catch(e => console.log("Error setting remote description:", e));
            }

            if (signal.ice) {
                connections[fromId].addIceCandidate(new RTCIceCandidate(signal.ice)).catch(e => console.log("Error adding ICE candidate:", e));
            }
        }
    }

    // Connects to the Socket.IO server and sets up event listeners
    let connectToSocketServer = () => {
        socketRef.current = io.connect(server_url, { secure: false });

        socketRef.current.on('signal', gotMessageFromServer);

        socketRef.current.on('connect', () => {
            console.log("Connected to socket server with ID:", socketRef.current.id);
            socketRef.current.emit('join-call', window.location.href); // Join a call room based on URL
            socketIdRef.current = socketRef.current.id; // Store current socket ID

            socketRef.current.on('chat-message', addMessage); // Listen for incoming chat messages

            // Handle user leaving the call
            socketRef.current.on('user-left', (id) => {
                console.log(`User ${id} left the call.`);
                if (connections[id]) {
                    connections[id].close(); // Close the peer connection
                    delete connections[id]; // Remove from connections map
                }
                setVideos((videos) => videos.filter((video) => video.socketId !== id)); // Remove video from state
            });

            // Handle new user joining the call
            socketRef.current.on('user-joined', (id, clients) => {
                console.log(`User ${id} joined. Current clients:`, clients);
                clients.forEach((socketListId) => {
                    // Create a new RTCPeerConnection for each existing client
                    connections[socketListId] = new RTCPeerConnection(peerConfigConnections);

                    // Listen for ICE candidates and send them via socket
                    connections[socketListId].onicecandidate = function (event) {
                        if (event.candidate != null) {
                            socketRef.current.emit('signal', socketListId, JSON.stringify({ 'ice': event.candidate }));
                        }
                    }

                    // Listen for incoming media tracks from remote peers (modern WebRTC)
                    connections[socketListId].ontrack = (event) => {
                        console.log("Received remote track:", event.track.kind, "from", socketListId);
                        setVideos(prevVideos => {
                            let videoExists = prevVideos.find(v => v.socketId === socketListId);
                            if (videoExists) {
                                // If video object already exists, update its stream (e.g., if stream changes)
                                const updatedVideos = prevVideos.map(v =>
                                    v.socketId === socketListId ? { ...v, stream: event.streams[0] } : v
                                );
                                videoRef.current = updatedVideos; // Update ref
                                return updatedVideos;
                            } else {
                                // Create a new video object for the new stream
                                const newVideo = {
                                    socketId: socketListId,
                                    stream: event.streams[0],
                                    autoplay: true,
                                    playsinline: true
                                };
                                const updatedVideos = [...prevVideos, newVideo];
                                videoRef.current = updatedVideos; // Update ref
                                return updatedVideos;
                            }
                        });
                    };

                    // Add the local video stream tracks to the new peer connection
                    if (window.localStream) {
                        window.localStream.getTracks().forEach(track => {
                            connections[socketListId].addTrack(track, window.localStream);
                        });
                    } else {
                        // Fallback to black/silent if localStream is not yet available
                        let blackSilence = (...args) => new MediaStream([black(...args), silence()]);
                        window.localStream = blackSilence();
                        window.localStream.getTracks().forEach(track => {
                            connections[socketListId].addTrack(track, window.localStream);
                        });
                    }
                });

                // If the current user is the one who just joined, send offers to existing clients
                if (id === socketIdRef.current) {
                    for (let id2 in connections) {
                        if (id2 === socketIdRef.current) continue; // Don't connect to self

                        try {
                            if (window.localStream) {
                                window.localStream.getTracks().forEach(track => {
                                    connections[id2].addTrack(track, window.localStream);
                                });
                            }
                        } catch (e) { console.log("Error adding local stream to existing connection:", e); }

                        // Create and send SDP offer
                        connections[id2].createOffer().then((description) => {
                            connections[id2].setLocalDescription(description)
                                .then(() => {
                                    socketRef.current.emit('signal', id2, JSON.stringify({ 'sdp': connections[id2].localDescription }));
                                })
                                .catch(e => console.log("Error setting local description for offer to existing client:", e));
                        }).catch(e => console.log("Error creating offer to existing client:", e));
                    }
                }
            });
        });
    }

    // Helper function to create a silent audio track
    let silence = () => {
        let ctx = new AudioContext();
        let oscillator = ctx.createOscillator();
        let dst = oscillator.connect(ctx.createMediaStreamDestination());
        oscillator.start();
        ctx.resume(); // Ensure audio context is resumed
        return Object.assign(dst.stream.getAudioTracks()[0], { enabled: false });
    }

    // Helper function to create a black video track
    let black = ({ width = 640, height = 480 } = {}) => {
        let canvas = Object.assign(document.createElement("canvas"), { width, height });
        canvas.getContext('2d').fillRect(0, 0, width, height);
        let stream = canvas.captureStream();
        return Object.assign(stream.getVideoTracks()[0], { enabled: false });
    }

    // Toggles the local video stream on/off
    let handleVideo = () => {
        setVideo((prevVideo) => {
            const newVideoState = !prevVideo;
            if (window.localStream) {
                const videoTrack = window.localStream.getVideoTracks()[0];
                if (videoTrack) {
                    videoTrack.enabled = newVideoState; // Directly enable/disable the track
                }
            }
            return newVideoState;
        });
    }

    // Toggles the local audio stream on/off (mute/unmute)
    let handleAudio = () => {
        setAudio((prevAudio) => {
            const newAudioState = !prevAudio;
            if (window.localStream) {
                const audioTrack = window.localStream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = newAudioState; // Directly enable/disable the track
                }
            }
            return newAudioState;
        });
    }

    // Toggles screen sharing on/off
    let handleScreen = () => {
        setScreen((prevScreen) => !prevScreen); // Toggling the state will trigger the useEffect for getDisplayMedia
    }

    // Handles ending the call
    let handleEndCall = () => {
        try {
            // Stop all local media tracks
            if (localVideoref.current && localVideoref.current.srcObject) {
                localVideoref.current.srcObject.getTracks().forEach(track => track.stop());
            }
            // Close all peer connections
            for (let id in connections) {
                if (connections[id]) {
                    connections[id].close();
                }
            }
            // Disconnect from socket
            if (socketRef.current) {
                socketRef.current.disconnect();
            }
        } catch (e) { console.log("Error ending call:", e); }
        window.location.href = "/"; // Redirect to home page
    }

    // Opens the chat modal and resets new message count
    let openChat = () => {
        setModal(true);
        setNewMessages(0);
    }

    // Closes the chat modal
    let closeChat = () => {
        setModal(false);
    }

    // Updates the message state as user types
    let handleMessage = (e) => {
        setMessage(e.target.value);
    }

    // Adds a new message to the messages state
    const addMessage = (data, sender, socketIdSender) => {
        setMessages((prevMessages) => [
            ...prevMessages,
            { sender: sender, data: data, socketId: socketIdSender } // Store socketId to identify sender
        ]);
        // Increment new message count if message is not from self and chat is closed
        if (socketIdSender !== socketIdRef.current && !showModal) {
            setNewMessages((prevNewMessages) => prevNewMessages + 1);
        }
    };

    // Sends a chat message via socket
    let sendMessage = () => {
        if (socketRef.current && message.trim() !== "") {
            socketRef.current.emit('chat-message', message, username);
            setMessage(""); // Clear the input field
        }
    }

    // Connects to the meeting after username is entered
    let connect = () => {
        if (username.trim() === "") {
            // Using a simple alert for now, consider a custom modal for better UX
            alert("Please enter a username to connect.");
            return;
        }
        setAskForUsername(false); // Hide lobby
        getMedia(); // Start media and socket connection
    }

    return (
        <div>
            {askForUsername === true ? (
                // Lobby/Username Input Screen
                <div className={styles.lobbyContainer}>
                    <h2>Enter into Lobby</h2>
                    <TextField
                        id="username-input"
                        label="Username"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        variant="outlined"
                        onKeyPress={(e) => {
                            if (e.key === 'Enter') {
                                connect();
                            }
                        }}
                        sx={{
                            '& .MuiOutlinedInput-root': {
                                '& fieldset': { borderColor: 'rgba(255, 255, 255, 0.5)' },
                                '&:hover fieldset': { borderColor: 'white' },
                                '&.Mui-focused fieldset': { borderColor: '#4CAF50' },
                            },
                            '& .MuiInputLabel-root': { color: 'white' },
                            '& .MuiInputBase-input': { color: 'white' }
                        }}
                    />
                    <Button variant="contained" onClick={connect} style={{ marginTop: '20px' }}>
                        Connect
                    </Button>
                    <div style={{ marginTop: '30px' }}>
                        {/* Local video preview in lobby */}
                        <video ref={localVideoref} autoPlay muted className={styles.lobbyVideoPreview}></video>
                    </div>
                </div>
            ) : (
                // Main Video Meeting Screen
                <div className={styles.meetVideoContainer}>

                    {/* Chat Room */}
                    <div className={`${styles.chatRoom} ${!showModal ? styles.hidden : ''}`}>
                        <div className={styles.chatContainer}>
                            <h1>Chat</h1>
                            <div className={styles.chattingDisplay}>
                                {messages.length !== 0 ? messages.map((item, index) => {
                                    // Apply 'myMessage' class if sender is current user
                                    const isMyMessage = item.socketId === socketIdRef.current;
                                    return (
                                        <div
                                            key={index}
                                            className={isMyMessage ? styles.myMessage : ''}
                                        >
                                            <p>{item.sender}</p>
                                            <p>{item.data}</p>
                                        </div>
                                    )
                                }) : <p>No Messages Yet</p>}
                            </div>

                            <div className={styles.chattingArea}>
                                <TextField
                                    value={message}
                                    onChange={handleMessage}
                                    id="chat-input"
                                    label="Enter your message"
                                    variant="outlined"
                                    fullWidth
                                    onKeyPress={(e) => {
                                        if (e.key === 'Enter') {
                                            sendMessage();
                                        }
                                    }}
                                />
                                <Button variant='contained' onClick={sendMessage}>
                                    Send
                                </Button>
                            </div>
                        </div>
                    </div>

                    {/* Control Buttons */}
                    <div className={styles.buttonContainers}>
                        <IconButton onClick={handleVideo} style={{ color: "white" }}>
                            {video ? <VideocamIcon /> : <VideocamOffIcon />}
                        </IconButton>
                        <IconButton onClick={handleEndCall} style={{ color: "red" }}>
                            <CallEndIcon />
                        </IconButton>
                        <IconButton onClick={handleAudio} style={{ color: "white" }}>
                            {audio ? <MicIcon /> : <MicOffIcon />}
                        </IconButton>

                        {screenAvailable && ( // Only show screen share button if available
                            <IconButton onClick={handleScreen} style={{ color: "white" }}>
                                {screen ? <ScreenShareIcon /> : <StopScreenShareIcon />}
                            </IconButton>
                        )}

                        <Badge badgeContent={newMessages} max={99} color='error'>
                            <IconButton onClick={() => setModal(prev => !prev)} style={{ color: "white" }}>
                                <ChatIcon />
                            </IconButton>
                        </Badge>
                    </div>

                    {/* Local User's Video (Picture-in-Picture) */}
                    <video className={styles.meetUserVideo} ref={localVideoref} autoPlay muted playsInline></video>

                    {/* Remote Participants' Videos */}
                    <div className={styles.conferenceView}>
                        {videos.map((videoObj) => (
                            <div key={videoObj.socketId} className={styles.remoteVideoWrapper}>
                                <video
                                    data-socket={videoObj.socketId}
                                    ref={ref => {
                                        if (ref && videoObj.stream) {
                                            ref.srcObject = videoObj.stream;
                                        }
                                    }}
                                    autoPlay
                                    playsInline
                                >
                                </video>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

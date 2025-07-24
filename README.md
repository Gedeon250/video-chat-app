# Video Meeting Room 📹

A simple, Google Meet-like video calling application built with Stream Video API. This application allows multiple users to join video calls, share screens, and interact in real-time.

## Features

✅ **Google Meet-like Interface**: Clean, modern UI similar to Google Meet
✅ **Multi-participant Video Calls**: Support for multiple participants
✅ **Screen Sharing**: Share your screen with other participants
✅ **Mute/Unmute**: Toggle microphone on/off
✅ **Camera Toggle**: Turn camera on/off
✅ **Dynamic Video Grid**: Automatically adjusts layout based on participant count
✅ **Fullscreen Mode**: Click any video to expand to fullscreen
✅ **Secure Credentials**: API credentials loaded securely from server
✅ **Responsive Design**: Works on desktop and mobile devices

## Setup Instructions

### 1. Environment Variables
Your Stream API credentials are already configured in the `.env` file:
- API Key: `egekq33k342s`
- Secret Key: `qw6667ttqwxwtghs4ygbe4ssxpnhw9ftaz5n4d59ztyj54buu3htj3zupm7phpv7`
- App ID: `1408094`

### 2. Install Dependencies
```bash
npm install
```

### 3. Start the Application
```bash
npm start
```

The application will be available at: `http://localhost:3001`

## How to Use

### Joining a Meeting
1. Open `http://localhost:3001` in your browser
2. Allow camera and microphone permissions when prompted
3. Enter your name (or use the default "Guest User")
4. Click "Join Meeting"

### During the Meeting
- **Mute/Unmute**: Click the microphone button
- **Camera On/Off**: Click the camera button
- **Screen Share**: Click the screen share button
- **Leave Meeting**: Click the red phone button
- **Fullscreen Video**: Click on any video tile to expand it

### Testing with Multiple Users
1. Open multiple browser tabs or different browsers
2. Navigate to `http://localhost:3001` in each
3. Join the same meeting room
4. All participants will see each other automatically

## Features Breakdown

### 🎥 Video Grid Layout
- **1 participant**: Large centered video
- **2 participants**: Side-by-side layout
- **3 participants**: Featured speaker + 2 smaller videos
- **4+ participants**: Automatic grid layout

### 🖥️ Screen Sharing
- Click the screen share button to share your screen
- Shared screen appears in fullscreen overlay
- Other participants see your screen in real-time

### 📱 Responsive Design
- Works on desktop, tablet, and mobile
- Touch-friendly controls
- Adaptive video layouts

### 🔒 Security
- API credentials are stored securely on the server
- No sensitive information exposed to frontend
- Secure token-based authentication

## File Structure

```
video-chat-app/
├── .env                 # Environment variables (API credentials)
├── server.js            # Express server
├── package.json         # Node.js dependencies
├── index.html          # Main HTML file
├── style.css           # Google Meet-like styling
├── script.js           # Video calling functionality
└── README.md           # This file
```

## Troubleshooting

### Camera/Microphone Issues
- Make sure to allow camera and microphone permissions
- Check if other applications are using your camera
- Try refreshing the page

### Connection Issues
- Ensure you have a stable internet connection
- Check if the server is running (`npm start`)
- Verify the Stream API credentials are correct

### Multiple Participants Not Connecting
- All participants must join the same meeting room
- The room ID is currently fixed as 'video-meeting-room'
- Each participant gets a unique user ID automatically

## Development Notes

- Built with vanilla JavaScript (no frameworks)
- Uses Stream Video API for real-time communication
- Express.js server for serving files and API endpoints
- Material Icons for button icons
- CSS Grid for responsive video layouts

## Next Steps for Enhancement

1. **Chat Feature**: Add text messaging during calls
2. **Recording**: Add meeting recording capability
3. **Breakout Rooms**: Support for smaller group sessions
4. **Virtual Backgrounds**: Add background blur/replacement
5. **Meeting Scheduling**: Add calendar integration
6. **User Authentication**: Add proper user login system

Enjoy your video meetings! 🎉

# Simple Video Chat App

A basic Google Meet-like application using Stream Video API.

## Features
- Join/leave video calls
- Screen sharing
- Audio mute/unmute
- File sharing (UI only - no actual transfer)

## Setup
1. Get your Stream API key from [Stream Dashboard](https://getstream.io/dashboard/)
2. Replace `YOUR_API_KEY` in `script.js` with your actual API key
3. Open `index.html` in a browser

## Limitations
This is a simplified demo:
- No proper user authentication
- No actual file transfer (just UI)
- Fixed call ID for demo purposes
- No error handling for all cases

## Next Steps
To make this production-ready:
1. Implement proper authentication
2. Add server for file sharing
3. Improve error handling
4. Add more features like chat, reactions, etc.

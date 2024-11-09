module.exports = {
    spotify: {
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        scopes: 'user-library-read playlist-modify-public',
        baseUrl: process.env.SPOTIFY_BASE_URL || 'http://localhost:3000',
        defaults: {
            playlistName: process.env.SPOTIFY_DEFAULT_PLAYLIST_NAME || "Liked Songs",
            playlistDescription: process.env.SPOTIFY_DEFAULT_PLAYLIST_DESCRIPTION || "Managed by https://github.com/Stef-00012/Likeify"
        }
    },
    web: {
        port: 3000
    },
    refreshInterval: Number.parseInt(process.env.REFRESH_INTERVAL) || 30 * 60 * 1000 // 30 minutes in milliseconds
}
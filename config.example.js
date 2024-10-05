module.exports = {
    spotify: {
        clientId: '', // Spotify Client ID
        clientSecret: '', // Spotify Client Secret
        scopes: 'user-library-read playlist-modify-public', // Spotify OAuth2 Scopes
        baseUrl: 'http://localhost:3000' // Base URL for Spotify Oauth2, used for login & logout redirect URIs 
    },
    web: {
        port: 3000 // Port for the webserver
    },
    refreshInterval: 30 * 60 * 1000 // 30 minutes in milliseconds, how often update the liked songs playlist
}
# Likeify

Likeify is a script that runs every 30 minutes (can be configured) and creates (or modified if it was already created earlier by the script) a playlist with your Spotify liked songs so you can have them public.

## How to Run?

1. `git clone https://github.com/Stef-00012/Likeify` - Clone the repository.
2. `cd Likeify` - Enter the directory of the repository.
3. `npm run db:setup` - Setup the database, only for first run.
4. rename `config.example.js` to `config.js` and fill the config, see [#Config](https://github.com/Stef-00012/Likeify#config).
5. `npm run start`

then visit `http://localhost:3000/login` (or the domain/port that you use) and login with Spotify.

## Config

> [!IMPORTANT]
> You'll need a Spotify application.
> To create an application:
> 1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
> 2. Press the "Create app" button on the top right.
> 3. Fill the required fields (make sure to check the Web API box) and press "Save".
> 4. Press "Settings" button on the top right.
> 5. Copy the client ID and client secret (you'll need to first click "View client secret" to see your client secret).

- `spotify` (Object):
    - `clientId` (String): Your Spotify application client ID.
    - `clientSecret` (String): Your Spotify application client secret.
    - `scopes` (String): Your Spotify application scopes (for the app to run is enough `user-library-read playlist-modify-public`).
    - `baseUrl` (String): Base URL used for login and logout (they'be `<baseUrl>/login` and `<baseUrl>/logout`, **you need to add those 2 as "Redirect URIs" in the Spotify application settings**).
- `web` (Object):
    - `port` (Number): The port used for the webserver, required for the Spotify OAuth2.
- `refreshInterval` (Number): How often update the liked songs playlist (in milliseconds), defaults to 30 minutes.


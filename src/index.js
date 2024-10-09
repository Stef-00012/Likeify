const sleep = require("node:util").promisify(setTimeout);
const { eq } = require("drizzle-orm");
const schema = require("./db/schema.js");
const config = require("../config.js");
const express = require("express");
const db = require("./db/db.js")();
const axios = require("axios");
const path = require("node:path");
const cookieParser = require('cookie-parser')

const clientSecret = config.spotify.clientSecret;
const clientId = config.spotify.clientId;

let nextRun = Date.now();

infoLog(`Refresh interval is set to ${config.refreshInterval}ms`);

setInterval(syncData, config.refreshInterval);

(async () => {
	await syncData();
})();

const app = express();

app.use(cookieParser())

app.use("/", express.static(path.join(__dirname, "frontend", "static")));

app.get("/", (req, res) => {
	res.cookie('nextUpdate', `${nextRun}`, {
		expires: new Date('2038-01-19T04:14:07.000Z')
	})

	return res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.get("/login", async (req, res) => {
	if (req.cookies?.username || req.cookies?.id) return res.redirect('/?login=2');

	const code = req.query.code;
	let state = req.query.state;

	if (!code || !state) {
		state = generateRandomString(16);

		const urlParams = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			scope: config.spotify.scopes,
			redirect_uri: `${config.spotify.baseUrl}/login`,
			state,
		});

		const spotifyAuthUrl = `https://accounts.spotify.com/authorize?${urlParams}`;

		return res.redirect(spotifyAuthUrl);
	}

	const tokenData = await getUserToken(code);

	if (!tokenData) return res.status(401).redirect("/?login=0");

	const user = await getUser(tokenData.access_token, tokenData.refresh_token);

	if (!user) return res.status(401).redirect("/?login=0");

	infoLog(`Got a new user "${user.display_name}" (${user.id})`);

	await db
		.insert(schema.users)
		.values({
			id: user.id,
			username: user.display_name,
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
		})
		.onConflictDoUpdate({
			target: schema.users.id,
			set: {
				username: user.display_name,
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
			},
		});

	if (nextRun - Date.now() > 2 * 60 * 1000)
		syncUser({
			id: user.id,
			playlistId: null,
			lastRun: user.lastRun,
			username: user.display_name,
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
		});

	res.cookie('username', user.display_name, {
		expires: new Date('2038-01-19T04:14:07.000Z')
	})

	res.cookie('id', user.id, {
		expires: new Date('2038-01-19T04:14:07.000Z')
	})

	return res.redirect("/?login=1");
});

app.get("/logout", async (req, res) => {
	const code = req.query.code;
	let state = req.query.state;

	if (!code || !state) {
		state = generateRandomString(16);

		const urlParams = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			scope: config.spotify.scopes,
			redirect_uri: `${config.spotify.baseUrl}/logout`,
			state,
		});

		const spotifyAuthUrl = `https://accounts.spotify.com/authorize?${urlParams}`;

		res.cookie('username', '', {
			maxAge: 0
		})

		res.cookie('id', '', {
			maxAge: 0
		})

		return res.redirect(spotifyAuthUrl);
	}

	const tokenData = await getUserToken(code, true);

	if (!tokenData) return res.status(404).redirect("/?logout=0");

	const user = await getUser(tokenData.access_token, tokenData.refresh_token);

	if (!user) return res.status(404).redirect("/?logout=0");

	infoLog(`User logout "${user.display_name}" (${user.id})`);

	await db.delete(schema.users).where(eq(schema.users.id, user.id));

	return res.redirect("/?logout=1");
});

app.all("*", (req, res) => {
	return res.sendStatus(404);
});

app.listen(config.web?.port || 3000, () => {
	infoLog(
		`Webserver is running on ${config.spotify.baseUrl} (port ${config.web.port})`,
	);
});

async function createPlaylist(name, description, accessToken) {
	infoLog("Creating liked songs playlist...");

	const playlistEndpoint = "https://api.spotify.com/v1/me/playlists";

	try {
		const res = await ratelimitHandledPost(
			playlistEndpoint,
			{
				name,
				description,
			},
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
			},
		);

		const data = res.data;

		await db
			.update(schema.users)
			.set({
				playlistId: data.id,
			})
			.where(eq(schema.users.accessToken, accessToken));

		infoLog(`Successfully created the liked songs playlist, id = ${data.id}`);

		return data.id;
	} catch (e) {
		errorLog("Something went wrong while creating the liked songs playlist...");

		errorLog(e?.response?.data || e);
	}
}

async function emptyPlaylist(playlistId, songs, accessToken) {
	infoLog("Removing the old liked songs form the liked songs playlist...");

	const deletePlaylistSongsEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;

	const batches = [];
	const batchJobs = [];
	let count = 0;

	for (let i = 0; i < songs.length; i += 100) {
		batches.push(songs.slice(i, i + 100));
	}

	for (const batch of batches) {
		const tracks = batch.map((trackId) => ({
			uri: `spotify:track:${trackId}`,
		}));

		try {
			const res = await ratelimitHandledDelete(deletePlaylistSongsEndpoint, {
				data: {
					tracks,
				},
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
			});

			batchJobs.push(res.status === 200);

			count += batch.length;

			infoLog(
				`Removed ${batch.length} other songs, total removed = ${count} | total songs = ${songs.length}`,
			);
		} catch (e) {
			if (e?.response?.status === 401) {
				errorLog(
					"Something went wrong while removing the liked songs to the liked songs playlist [Unauthorized]...",
				);

				return false;
			}

			errorLog(
				"Something went wrong while removing the liked songs to the liked songs playlist...",
			);

			errorLog(e?.response?.data || e);

			batchJobs.push(e?.response?.status === 200);
		}
	}

	return batchJobs.every(Boolean);
}

async function fillPlaylist(playlistId, songs, accessToken) {
	infoLog("Adding the liked songs to the liked songs playlist...");

	const addPlaylistSongsEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;

	const batches = [];
	const batchJobs = [];
	let count = 0;

	for (let i = 0; i < songs.length; i += 100) {
		batches.push(songs.slice(i, i + 100));
	}

	for (const batch of batches) {
		const tracks = batch.map((trackId) => `spotify:track:${trackId}`);

		try {
			const res = await ratelimitHandledPost(
				addPlaylistSongsEndpoint,
				{
					uris: tracks,
				},
				{
					headers: {
						Authorization: `Bearer ${accessToken}`,
					},
				},
			);

			batchJobs.push(res.status === 201);

			count += batch.length;

			infoLog(
				`Added ${batch.length} new songs, total added = ${count} | total songs = ${songs.length}`,
			);
		} catch (e) {
			if (e?.response?.status === 401) {
				errorLog(
					"Something went wrong while adding the liked songs to the liked songs playlist [Unauthorized]...",
				);

				return false;
			}

			errorLog(
				"Something went wrong while adding the liked songs to the liked songs playlist...",
			);

			errorLog(e?.response?.data || e);

			batchJobs.push(e?.response?.status === 200);
		}
	}

	return batchJobs.every(Boolean);
}

async function getPlaylistData(playlistId, accessToken) {
	infoLog("Fetching liked songs playlist data...");

	const playlistEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}`;

	try {
		const res = await ratelimitHandledGet(playlistEndpoint, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		const data = res.data;

		const playlistData = {
			name: data.name,
			description: data.description,
		};

		infoLog("Successfully fetched the liked songs playlist data", playlistData);

		return playlistData;
	} catch (e) {
		errorLog(
			"Something went wrong while fetching the liked songs playlist data...",
		);

		errorLog(e?.response?.data || e);
	}
}

async function existsPlaylist(playlistId, accessToken) {
	infoLog("Checking if user has deleted the liked songs playlist...");

	const playlistFollowEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}/followers/contains`;

	try {
		const res = await ratelimitHandledGet(playlistFollowEndpoint, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		const isDeleted = res.data?.[0] || false;

		infoLog(
			`Successfully checked if the user has deleted the liked songs playlist, exists = ${isDeleted}`,
		);

		return isDeleted;
	} catch (e) {
		errorLog(
			"Something went wrong while checking if the user has deleted the liked songs playlist...",
		);

		errorLog(e?.response?.data || e);
	}
}

async function deletePlaylist(playlistId, accessToken) {
	infoLog("Unfollowing old liked songs playlist...");

	const unfollowPlaylistEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}/followers`;

	try {
		await ratelimitHandledDelete(unfollowPlaylistEndpoint, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		infoLog("Successfully unfollowed old liked songs playlist");
	} catch (e) {
		errorLog(
			"Something went wrong while unfollowing the liked songs playlist...",
		);

		errorLog(e?.response?.data || e);
	}
}

async function getUserToken(code, logout = false) {
	infoLog("Fetching user token...");

	const tokenData = new URLSearchParams({
		code,
		redirect_uri: `${config.spotify.baseUrl}/${logout ? "logout" : "login"}`,
		grant_type: "authorization_code",
	});

	const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

	try {
		const res = await ratelimitHandledPost(
			"https://accounts.spotify.com/api/token",
			tokenData,
			{
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			},
		);

		const data = res.data;

		infoLog("Successfully fetched user token", data);

		return data;
	} catch (e) {
		errorLog("Something went wrong while fetching the user token...");

		errorLog(e?.response?.data || e);
	}
}

async function getUser(accessToken, refreshToken) {
	infoLog("Fetching the current user...");

	const userEndpoint = "https://api.spotify.com/v1/me";

	try {
		const res = await ratelimitHandledGet(userEndpoint, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		const data = res.data;

		infoLog("Successfully fetched the current user", data);

		return data;
	} catch (e) {
		if (e?.response?.status === 401 && refreshToken) {
			try {
				const refreshedData = await refreshUserToken(refreshToken);

				return await getUser(refreshedData.access_token);
			} catch (e) {
				errorLog("Something went wrong while fetching the current user...");

				errorLog(e?.response?.data || e);
			}
		}

		errorLog("Something went wrong while fetching the current user...");

		errorLog(e?.response?.data || e);
	}
}

async function ratelimitHandledDelete(...data) {
	try {
		const res = await axios.delete(...data);

		return res;
	} catch (e) {
		if (e?.response?.status === 429) {
			const retryAfter = e.response.headers.get("Retry-After");

			await sleep(Number.parseInt(retryAfter) * 1000);

			return await ratelimitHandledDelete(...data);
		}
	}
}

async function refreshUserToken(refreshToken) {
	infoLog("Refreshing the current user token...");

	const refreshUrl = "https://accounts.spotify.com/api/token";

	const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

	const refreshData = {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	};

	try {
		const res = await ratelimitHandledPost(
			refreshUrl,
			new URLSearchParams(refreshData),
			{
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			},
		);

		const tokenData = res.data;

		await db
			.update(schema.users)
			.set({
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
			})
			.where(eq(schema.users.refreshToken, refreshToken));

		infoLog("Successfully refreshed the current user token", tokenData);

		return tokenData;
	} catch (e) {
		if (e?.response?.data?.error === "invalid_grant") {
			warnLog("User has revoked the token, removing...");

			await db
				.delete(schema.users)
				.where(eq(schema.users.refreshToken, refreshToken));

			infoLog("Successfully removed the user");

			return null;
		}

		errorLog("Something went wrong while refreshing the current user token...");

		errorLog(e?.response?.data || e);

		return null;
	}
}

async function ratelimitHandledPost(...data) {
	try {
		const res = await axios.post(...data);

		return res;
	} catch (e) {
		if (e?.response?.status === 429) {
			const retryAfter = e.response.headers.get("Retry-After");

			await sleep(Number.parseInt(retryAfter) * 1000);

			return await ratelimitHandledPost(...data);
		}
	}
}

async function ratelimitHandledGet(...data) {
	try {
		const res = await axios.get(...data);

		return res;
	} catch (e) {
		if (e?.response?.status === 429) {
			const retryAfter = e.response.headers.get("Retry-After");

			await sleep(Number.parseInt(retryAfter) * 1000);

			return await ratelimitHandledGet(...data);
		}
	}
}

async function getLikedSongs(accessToken) {
	infoLog("Fetching current user liked songs...");

	const allSongs = [];
	let count = 0;

	let nextUrl = "https://api.spotify.com/v1/me/tracks?limit=50";

	try {
		while (nextUrl) {
			const res = await ratelimitHandledGet(nextUrl, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			});

			const data = res.data;

			const likedSongs = data.items.map((item) => item.track.id);
			nextUrl = data.next;

			count += likedSongs.length;

			infoLog(`Fetched ${likedSongs.length} new songs, total = ${count}`);

			allSongs.push(...likedSongs);
		}

		infoLog(
			`Successfully fetched the current user liked songs, count = ${count}`,
		);

		return allSongs;
	} catch (e) {
		errorLog("Something went wrong while fetching current user liked songs...");

		errorLog(e?.response?.data || e);
	}
}

function generateRandomString(length) {
	infoLog("Generating the state...");

	let text = "";
	const possible =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

	for (let i = 0; i < length; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}

	infoLog("Successfully generated the state", text);

	return text;
}

async function syncUser(user) {
	if (!user) return;

	infoLog(`Starting sync for user "${user.username}" (${user.id})...`);

	if (user.lastRun && Date.now() - user.lastRun < 20 * 60 * 1000) {
		infoLog("User's last run was less than 20 minutes ago, skipping...");

		return false;
	}

	const refreshedTokenData = await refreshUserToken(user.refreshToken);

	if (!refreshedTokenData) {
		warnLog("Skipping user...");

		completedUsers++;

		await db
			.update(schema.users)
			.set({
				lastRun: Date.now(),
			})
			.where(eq(schema.users.id, user.id))
			.catch(() => {});

		return false;
	}

	infoLog("Fetching liked songs...");

	const likedSongs = await getLikedSongs(refreshedTokenData.access_token);

	if (!likedSongs) {
		warnLog("likedSongs is missing, skipping user...");

		await db
			.update(schema.users)
			.set({
				lastRun: Date.now(),
			})
			.where(eq(schema.users.id, user.id));

		return false;
	}

	if (!user.playlistId) {
		infoLog(
			"User doesn't have any playlist set as liked songs playlist, creating one...",
		);

		user.playlistId = await createPlaylist(
			config.spotify.defaults.playlistName || "Liked Songs",
			config.spotify.defaults.playlistDescription ||
				"Managed by https://liked.spotify.stefdp.lol.",
			refreshedTokenData.access_token,
		);
	}

	infoLog("Checking if playlist exists...");
	const existsUserPlaylist = await existsPlaylist(
		user.playlistId,
		refreshedTokenData.access_token,
	);

	if (!existsUserPlaylist) {
		infoLog(
			"User does not follow the liked songs playlist, creating a new one...",
		);

		user.playlistId = await createPlaylist(
			config.spotify.defaults.playlistName || "Liked Songs",
			config.spotify.defaults.playlistDescription ||
				"Managed by https://github.com/Stef-00012/Likeify",
			refreshedTokenData.access_token,
		);
	} else {
		infoLog("Fetching playlist info...");

		const playlistData = await getPlaylistData(
			user.playlistId,
			refreshedTokenData.access_token,
		);

		infoLog("Emptying liked song playlist...");

		const success = await emptyPlaylist(
			user.playlistId,
			likedSongs,
			refreshedTokenData.access_token,
		);

		if (!success) {
			warnLog("Failed to empty the liked song playlist, deleting it...");

			await deletePlaylist(user.playlistId, refreshedTokenData.access_token);

			infoLog("Creating a new liked songs playlist...");

			user.playlistId = await createPlaylist(
				playlistData?.name ||
					config.spotify.defaults.playlistName ||
					"Liked Songs",
				playlistData?.description ||
					config.spotify.defaults.playlistDescription ||
					"Managed by https://github.com/Stef-00012/Likeify",
				refreshedTokenData.access_token,
			);
		}
	}

	const success = await fillPlaylist(
		user.playlistId,
		likedSongs,
		refreshedTokenData.access_token,
	);

	if (success) infoLog("All songs were added successfully");
	else warnLog("Some songs were not added");

	await db
		.update(schema.users)
		.set({
			lastRun: Date.now(),
		})
		.where(eq(schema.users.id, user.id));

	return true;
}

function errorLog(...args) {
	console.info(
		`\x1b[32m[${new Date().toLocaleString()}] \x1b[31;1mERROR:\x1b[0m`,
		...args,
	);
}

function warnLog(...args) {
	console.info(
		`\x1b[32m[${new Date().toLocaleString()}] \x1b[33;1mWARN:\x1b[0m`,
		...args,
	);
}

function infoLog(...args) {
	console.info(
		`\x1b[32m[${new Date().toLocaleString()}] \x1b[34;1mINFO:\x1b[0m`,
		...args,
	);
}

async function syncData() {
	nextRun = Date.now() + 30 * 60 * 1000;

	const users = (await db.query.users.findMany()) || [];

	let completedUsers = 0;
	let completedUsersSuccessful = 0;

	if (!users || users.length <= 0) return infoLog("No users to sync");

	for (const user of users) {
		const userSync = await syncUser(user);

		completedUsers++;

		if (userSync) completedUsersSuccessful++;

		if (users.length > completedUsers) {
			infoLog("Waiting 10 seconds before doing next user...");

			await sleep(10 * 1000);
		}
	}

	infoLog(
		`Successfully synced all the users\n- Total Users: ${completedUsers}\n- Successful Syncs: ${completedUsersSuccessful}`,
	);
	infoLog(`Next run will be at ${new Date(nextRun).toLocaleString()}`);
}

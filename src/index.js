const sleep = require("node:util").promisify(setTimeout);
const { eq } = require("drizzle-orm");
const schema = require("./db/schema.js");
const config = require("../config.js");
const express = require("express");
const db = require("./db/db.js")();
const axios = require("axios");

const clientSecret = config.spotify.clientSecret;
const clientId = config.spotify.clientId;

infoLog(`Refresh interval is set to ${config.refreshInterval}ms`);

setInterval(syncData, config.refreshInterval);

(async () => {
	await syncData();
})();

const app = express();

app.get("/login", async (req, res) => {
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

	if (!tokenData) return res.sendStatus(401);

	const user = await getUser(tokenData.access_token, tokenData.refresh_token);

	if (!user) return res.sendStatus(401);

	infoLog(`Got a new user "${user.display_name}" (${user.id})`);

	await db
		.insert(schema.users)
		.values({
			id: user.id,
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
		})
		.onConflictDoUpdate({
			target: schema.users.id,
			set: {
				accessToken: tokenData.access_token,
				refreshToken: tokenData.refresh_token,
			},
		});

	return res.sendStatus(200);
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

		return res.redirect(spotifyAuthUrl);
	}

	const tokenData = await getUserToken(code, true);

	if (!tokenData) return res.sendStatus(404);

	const user = await getUser(tokenData.access_token, tokenData.refresh_token);

	if (!user) return res.sendStatus(404);

	infoLog(`User logout "${user.display_name}" (${user.id})`);

	await db.delete(schema.users).where(eq(schema.users.id, user.id));

	return res.sendStatus(200);
});

app.all("*", (req, res) => {
	return res.sendStatus(404);
});

app.listen(config.web?.port || 3000, () => {
	infoLog(
		`Webserver is running on ${config.spotify.baseUrl} (port ${config.web.port})`,
	);
});

async function createPlaylist(name, description, accessToken, refreshToken) {
	infoLog("Creating liked songs playlist...");

	const playlistEndpoint = "https://api.spotify.com/v1/me/playlists";

	try {
		const res = await axios.post(
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
		if (e?.response?.status === 401 && refreshToken) {
			try {
				const refreshedData = await refreshUserToken(refreshToken);

				return await createPlaylist(
					name,
					description,
					refreshedData.access_token,
				);
			} catch (e) {
				errorLog(
					"Something went wrong while creating the liked songs playlist...",
				);

				errorLog(e?.response?.data || e);
			}
		}

		errorLog("Something went wrong while creating the liked songs playlist...");

		errorLog(e?.response?.data || e);
	}
}

async function emptyPlaylist(playlistId, songs, accessToken, refreshToken) {
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
			const res = await axios.delete(deletePlaylistSongsEndpoint, {
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
			if (e?.response?.status === 401 && refreshToken) {
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

async function fillPlaylist(playlistId, songs, accessToken, refreshToken) {
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
			const res = await axios.post(
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
			if (e?.response?.status === 401 && refreshToken) {
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

async function getPlaylistData(playlistId, accessToken, refreshToken) {
	infoLog("Fetching liked songs playlist data...");

	const playlistEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}`;

	try {
		const res = await axios.get(playlistEndpoint, {
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
		if (e?.response?.status === 401 && refreshToken) {
			try {
				const refreshedData = await refreshUserToken(refreshToken);

				return await getPlaylistData(playlistId, refreshedData.access_token);
			} catch (e) {
				errorLog(
					"Something went wrong while fetching the liked songs playlist data...",
				);

				errorLog(e?.response?.data || e);
			}
		}

		errorLog(
			"Something went wrong while fetching the liked songs playlist data...",
		);

		errorLog(e?.response?.data || e);
	}
}

async function existsPlaylist(playlistId, accessToken, refreshToken) {
	infoLog("Checking if user has deleted the liked songs playlist...");

	const playlistFollowEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}/followers/contains`;

	try {
		const res = await axios.get(playlistFollowEndpoint, {
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
		if (e?.response?.status === 401 && refreshToken) {
			try {
				const refreshedData = await refreshUserToken(refreshToken);

				return await existsPlaylist(playlistId, refreshedData.access_token);
			} catch (e) {
				errorLog(
					"Something went wrong while checking if the user has deleted the liked songs playlist...",
				);

				errorLog(e?.response?.data || e);
			}
		}

		errorLog(
			"Something went wrong while checking if the user has deleted the liked songs playlist...",
		);

		errorLog(e?.response?.data || e);
	}
}

async function deletePlaylist(playlistId, accessToken, refreshToken) {
	infoLog("Unfollowing old liked songs playlist...");

	const unfollowPlaylistEndpoint = `https://api.spotify.com/v1/playlists/${playlistId}/followers`;

	try {
		await axios.delete(unfollowPlaylistEndpoint, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		infoLog("Successfully unfollowed old liked songs playlist");
	} catch (e) {
		if (e?.response?.status === 401 && refreshToken) {
			try {
				const refreshedData = await refreshUserToken(refreshToken);

				return await deletePlaylist(playlistId, refreshedData.access_token);
			} catch (e) {
				errorLog(
					"Something went wrong while unfollowing the liked songs playlist...",
				);

				errorLog(e?.response?.data || e);
			}
		}

		errorLog(
			"Something went wrong while unfollowing the liked songs playlist...",
		);

		errorLog(e?.response?.data || e);
	}
}

async function getLikedSongs(accessToken, refreshToken) {
	infoLog("Fetching current user liked songs...");

	const allSongs = [];
	let count = 0;

	let nextUrl = "https://api.spotify.com/v1/me/tracks?limit=50";

	try {
		while (nextUrl) {
			const res = await axios.get(nextUrl, {
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
		if (e?.response?.status === 401 && refreshToken) {
			try {
				const refreshedData = await refreshUserToken(refreshToken);

				return await getLikedSongs(refreshedData.access_token);
			} catch (e) {
				errorLog(
					"Something went wrong while fetching current user liked songs...",
				);

				errorLog(e?.response?.data || e);
			}
		}

		errorLog("Something went wrong while fetching current user liked songs...");

		errorLog(e?.response?.data || e);
	}
}

async function validateToken(accessToken, refreshToken) {
	infoLog("Checking is the token is valid...");

	const userEndpoint = "https://api.spotify.com/v1/me";

	try {
		const res = await axios.get(userEndpoint, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		});

		const data = res.data;

		infoLog("Token is valid", data);

		return true;
	} catch (e) {
		if (e?.response?.status === 401 && refreshToken) {
			try {
				const refreshedData = await refreshUserToken(refreshToken);

				if (!refreshedData) {
					infoLog("Token is not valid, removing the user...");

					return false;
				}

				return await getUser(refreshedData.access_token);
			} catch (e) {
				errorLog("Something went wrong while fetching the current user...");

				errorLog(e?.response?.data || e);

				return false;
			}
		}

		errorLog("Something went wrong while fetching the current user...");

		errorLog(e?.response?.data || e);

		return false;
	}
}

async function getUser(accessToken, refreshToken) {
	infoLog("Fetching the current user...");

	const userEndpoint = "https://api.spotify.com/v1/me";

	try {
		const res = await axios.get(userEndpoint, {
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

async function refreshUserToken(refreshToken) {
	infoLog("Refreshing the current user token...");

	const refreshUrl = "https://accounts.spotify.com/api/token";

	const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

	const refreshData = {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	};

	try {
		const res = await axios.post(refreshUrl, new URLSearchParams(refreshData), {
			headers: {
				Authorization: `Basic ${auth}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
		});

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

async function getUserToken(code, logout = false) {
	infoLog("Fetching user token...");

	const tokenData = new URLSearchParams({
		code,
		redirect_uri: `${config.spotify.baseUrl}/${logout ? "logout" : "login"}`,
		grant_type: "authorization_code",
	});

	const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

	try {
		const res = await axios.post(
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

async function syncData() {
	const users = (await db.query.users.findMany()) || [];

	let completedUsers = 0;

	if (!users || users.length <= 0) return infoLog("No users to sync");

	for (const user of users) {
		infoLog(`Starting sync for user "${user.id}"...`);

		const isTokenValid = await validateToken(
			user.accessToken,
			user.refreshToken,
		);

		if (!isTokenValid) {
			warnLog("Skipping user...");

			completedUsers++;

			if (users.length > completedUsers) {
				infoLog("Waiting 10 seconds before doing next user...");

				await sleep(10 * 1000); // wait 10 seconds after each user

				continue;
			}
		}

		infoLog("Fetching liked songs...");
		const likedSongs = await getLikedSongs(user.accessToken, user.refreshToken);

		if (!likedSongs) {
			warnLog("likedSongs is missing, skipping user...");

			completedUsers++;

			if (users.length > completedUsers) {
				infoLog("Waiting 10 seconds before doing next user...");

				await sleep(10 * 1000); // wait 10 seconds after each user

				continue;
			}
		}

		if (!user.playlistId) {
			infoLog(
				"User doesn't have any playlist set as liked songs playlist, creating one...",
			);

			user.playlistId = await createPlaylist(
				config.spotify.defaults.playlistName || "Liked Songs",
				config.spotify.defaults.playlistDescription ||
					"Managed by https://liked.spotify.stefdp.lol.",
				user.accessToken,
				user.refreshToken,
			);
		}

		infoLog("Checking if playlist exists...");
		const existsUserPlaylist = await existsPlaylist(
			user.playlistId,
			user.accessToken,
			user.refreshToken,
		);

		if (!existsUserPlaylist) {
			infoLog(
				"User does not follow the liked songs playlist, creating a new one...",
			);

			user.playlistId = await createPlaylist(
				config.spotify.defaults.playlistName || "Liked Songs",
				config.spotify.defaults.playlistDescription ||
					"Managed by https://github.com/Stef-00012/Likeify",
				user.accessToken,
				user.refreshToken,
			);
		} else {
			infoLog("Fetching playlist info...");

			const playlistData = await getPlaylistData(
				user.playlistId,
				user.accessToken,
				user.refreshToken,
			);

			infoLog("Emptying liked song playlist...");

			const success = await emptyPlaylist(
				user.playlistId,
				likedSongs,
				user.accessToken,
				user.refreshToken,
			);

			if (!success) {
				warnLog("Failed to empty the liked song playlist, deleting it...");

				await deletePlaylist(
					user.playlistId,
					user.accessToken,
					user.refreshToken,
				);

				infoLog("Creating a new liked songs playlist...");

				user.playlistId = await createPlaylist(
					playlistData?.name ||
						config.spotify.defaults.playlistName ||
						"Liked Songs",
					playlistData?.description ||
						config.spotify.defaults.playlistDescription ||
						"Managed by https://github.com/Stef-00012/Likeify",
					user.accessToken,
					user.refreshToken,
				);
			}
		}

		const success = await fillPlaylist(
			user.playlistId,
			likedSongs,
			user.accessToken,
			user.refreshToken,
		);

		if (success) infoLog("All songs were added successfully");
		else warnLog("Some songs were not added");

		completedUsers++;

		if (users.length > completedUsers) {
			infoLog("Waiting 10 seconds before doing next user...");

			await sleep(10 * 1000); // wait 10 seconds after each user
		}
	}

	infoLog("Successfully synced all the users");
}

function errorLog(...args) {
	console.info(`${new Date().toISOString()}\x1b[31;1mERROR:\x1b[0m`, ...args);
}

function warnLog(...args) {
	console.info(`${new Date().toISOString()}\x1b[33;1mWARN:\x1b[0m`, ...args);
}

function infoLog(...args) {
	console.info(`${new Date().toISOString()}\x1b[34;1mINFO:\x1b[0m`, ...args);
}

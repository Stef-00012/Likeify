const {
	sqliteTable,
	integer,
	text
} = require("drizzle-orm/sqlite-core");

const users = sqliteTable("users", {
    id: text("id").notNull().primaryKey(),
    username: text("username").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    playlistId: text("playlist_id")
})

module.exports = {
    users
}
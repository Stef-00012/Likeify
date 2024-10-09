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
    playlistId: text("playlist_id"),
    lastRun: integer("last_run"),
    enabled: integer("enabled", {
        mode: "boolean"
    }).notNull().default(true)
})

module.exports = {
    users
}
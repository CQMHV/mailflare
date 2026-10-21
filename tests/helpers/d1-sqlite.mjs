import { DatabaseSync } from "node:sqlite";

function normalize(value) {
	if (value instanceof Date) return Math.floor(value.getTime() / 1000);
	if (typeof value === "boolean") return Number(value);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return value;
}

function meta(info) {
	return {
		duration: 0, size_after: 0, rows_read: 0, rows_written: Number(info?.changes ?? 0),
		last_row_id: Number(info?.lastInsertRowid ?? 0), changed_db: Number(info?.changes ?? 0) > 0,
		changes: Number(info?.changes ?? 0),
	};
}

class Statement {
	constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
	bind(...values) { return new Statement(this.db, this.sql, values.map(normalize)); }
	readable() { return /^\s*(select|with|pragma|explain)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql); }
	async first(column) {
		const row = this.db.prepare(this.sql).get(...this.values);
		return row ? column ? row[column] : row : null;
	}
	async run() {
		const statement = this.db.prepare(this.sql);
		if (this.readable()) return { results: statement.all(...this.values), success: true, meta: meta() };
		return { results: [], success: true, meta: meta(statement.run(...this.values)) };
	}
	async all() { return this.run(); }
	async raw(options) {
		const statement = this.db.prepare(this.sql);
		if (!this.readable()) { statement.run(...this.values); return []; }
		statement.setReturnArrays(true);
		const rows = statement.all(...this.values);
		return options?.columnNames ? [statement.columns().map(column => column.name), ...rows] : rows;
	}
}

/**
 * Real SQLite with D1 result shapes and atomic batch rollback, including Drizzle's raw rows.
 * This tests SQL and handlers locally; it does not simulate D1 networking, concurrency,
 * query limits, replica/session consistency, or production R2. License tracing is opt-in
 * so migrations can create the upstream schema before testing unlicensed features.
 */
export class SqliteDatabase {
	constructor(filename = ":memory:", { forbidLicenseQueries = false } = {}) {
		this.db = new DatabaseSync(filename);
		this.db.exec("PRAGMA foreign_keys = ON");
		this.forbiddenQueries = [];
		this.forbidLicenseQueries = forbidLicenseQueries;
	}
	prepare(sql) {
		if (this.forbidLicenseQueries && /\blicense_settings\b/i.test(sql)) {
			this.forbiddenQueries.push(sql);
			throw new Error("Runtime must not query commercial license settings");
		}
		return new Statement(this.db, sql);
	}
	async batch(statements) {
		this.db.exec("BEGIN");
		try {
			const results = [];
			for (const statement of statements) results.push(await statement.all());
			this.db.exec("COMMIT");
			return results;
		} catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	async exec(sql) { this.db.exec(sql); return { count: 0, duration: 0 }; }
	withSession() { return this; }
}

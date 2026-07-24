import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260624000000_session_goal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`goal_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`verification\` text NOT NULL,
          \`constraints\` text NOT NULL,
          \`boundaries\` text NOT NULL,
          \`iteration_policy\` text NOT NULL,
          \`blocked_condition\` text,
          \`token_budget\` integer,
          \`tokens_used\` integer NOT NULL DEFAULT 0,
          \`time_used_seconds\` integer NOT NULL DEFAULT 0,
          \`status\` text NOT NULL,
          \`evidence\` text NOT NULL DEFAULT '[]',
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_goal_session_unique\` ON \`session_goal\` (\`session_id\`);`)
      yield* tx.run(`
        CREATE TABLE \`session_goal_lesson\` (
          \`id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`attempt\` text NOT NULL,
          \`observed\` text NOT NULL,
          \`implication\` text NOT NULL,
          \`evidence\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_disabled\` integer,
          CONSTRAINT \`fk_session_goal_lesson_goal_id_session_goal_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`session_goal\`(\`goal_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_goal_lesson_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_goal_lesson_goal_idx\` ON \`session_goal_lesson\` (\`goal_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_goal_lesson_session_idx\` ON \`session_goal_lesson\` (\`session_id\`);`)
      yield* tx.run(`
        CREATE TABLE \`session_goal_settlement\` (
          \`goal_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`tokens_reasoning\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_read\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_write\` integer NOT NULL DEFAULT 0,
          \`time_seconds\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          PRIMARY KEY (\`goal_id\`, \`assistant_message_id\`),
          CONSTRAINT \`fk_session_goal_settlement_goal_id_session_goal_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`session_goal\`(\`goal_id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration

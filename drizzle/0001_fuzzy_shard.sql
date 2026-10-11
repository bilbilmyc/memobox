CREATE TABLE "eval_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_log_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"relevant" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_labels" ADD CONSTRAINT "eval_labels_query_log_id_query_log_id_fk" FOREIGN KEY ("query_log_id") REFERENCES "public"."query_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_labels" ADD CONSTRAINT "eval_labels_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_labels_pair_idx" ON "eval_labels" USING btree ("query_log_id","memory_id");
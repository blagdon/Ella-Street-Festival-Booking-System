


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."performance_type" AS ENUM (
    'Music',
    'Art',
    'Comedy',
    'Circus skills',
    'Other'
);


ALTER TYPE "public"."performance_type" OWNER TO "postgres";


CREATE TYPE "public"."performer_status" AS ENUM (
    'Applied',
    'Approved',
    'Scheduled',
    'Paid',
    'Rejected'
);


ALTER TYPE "public"."performer_status" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'admin',
    'steward'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."booking_locations_check_conflict"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_new_dataset  text;
    v_conflict_id  text;
BEGIN
    SELECT CASE WHEN instance_prefix LIKE '%-DEV-' THEN 'DEV' ELSE 'LIVE' END
      INTO v_new_dataset
    FROM bookings WHERE id = NEW.booking_id;

    SELECT bl.booking_id INTO v_conflict_id
    FROM booking_locations bl
    JOIN bookings b2 ON b2.id = bl.booking_id
    WHERE bl.location_id = NEW.location_id
      AND bl.booking_id <> NEW.booking_id
      AND b2.status = 'Confirmed'
      AND (CASE WHEN b2.instance_prefix LIKE '%-DEV-' THEN 'DEV' ELSE 'LIVE' END) = v_new_dataset
    LIMIT 1;

    IF v_conflict_id IS NOT NULL THEN
        RAISE EXCEPTION 'Location % is already assigned to booking %', NEW.location_id, v_conflict_id
            USING ERRCODE = 'unique_violation';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."booking_locations_check_conflict"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calculate_performer_total_cost"("performer_uuid" "uuid") RETURNS numeric
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  total DECIMAL(10,2);
BEGIN
  SELECT COALESCE(SUM(
    (s.duration_minutes / 30.0) * p.cost_per_30min
  ), 0)
  INTO total
  FROM schedules s
  JOIN performers p ON p.id = s.performer_id
  WHERE s.performer_id = performer_uuid;

  RETURN total;
END;
$$;


ALTER FUNCTION "public"."calculate_performer_total_cost"("performer_uuid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_booking_secure"("p_token" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_booking_id TEXT;
  v_status TEXT;
BEGIN
  SELECT id, status INTO v_booking_id, v_status
  FROM bookings
  WHERE cancel_token = p_token;

  IF v_booking_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired cancel token.');
  END IF;

  IF v_status NOT IN ('Pending', 'Confirmed', 'On Hold', 'HCC Checks') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Booking cannot be cancelled in its current state.');
  END IF;

  UPDATE bookings
  SET status = 'Cancelled',
      rejection_reason = p_reason,
      cancel_token = NULL
  WHERE id = v_booking_id;

  RETURN jsonb_build_object('success', true, 'booking_id', v_booking_id);
END;
$$;


ALTER FUNCTION "public"."cancel_booking_secure"("p_token" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_user_role"("required_role" "public"."user_role") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE id = auth.uid() AND role = required_role
  );
END;
$$;


ALTER FUNCTION "public"."check_user_role"("required_role" "public"."user_role") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."email_queue" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "recipient" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "bcc" "text",
    "status" "text" DEFAULT 'Pending'::"text",
    "error_message" "text",
    "instance_prefix" "text",
    "claimed_at" timestamp with time zone
);


ALTER TABLE "public"."email_queue" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_pending_emails"("p_batch_size" integer DEFAULT 50) RETURNS SETOF "public"."email_queue"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE public.email_queue
  SET status = 'Processing', claimed_at = now()
  WHERE id IN (
    SELECT id FROM public.email_queue
    WHERE status = 'Pending'
       OR (status = 'Processing' AND claimed_at < now() - INTERVAL '15 minutes')
    ORDER BY created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;


ALTER FUNCTION "public"."claim_pending_emails"("p_batch_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."eq_text_user_role"("text", "public"."user_role") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $_$
  SELECT $1 = $2::text;
$_$;


ALTER FUNCTION "public"."eq_text_user_role"("text", "public"."user_role") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."eq_user_role_text"("public"."user_role", "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $_$
  SELECT $1::text = $2;
$_$;


ALTER FUNCTION "public"."eq_user_role_text"("public"."user_role", "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_is_admin"() RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$;


ALTER FUNCTION "public"."get_is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_next_booking_id"("p_prefix" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  v_max_num INT;
  v_new_id  TEXT;
BEGIN
  -- Lock the table to prevent concurrent calls getting the same number
  LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(
    MAX(CAST(SPLIT_PART(id, p_prefix, 2) AS INT)),
    0
  )
  INTO v_max_num
  FROM bookings
  WHERE id LIKE p_prefix || '%'
    AND id ~ ('^' || p_prefix || '\d+$');

  v_new_id := p_prefix || LPAD((v_max_num + 1)::TEXT, 4, '0');

  RETURN v_new_id;
END;
$_$;


ALTER FUNCTION "public"."get_next_booking_id"("p_prefix" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."neq_text_user_role"("text", "public"."user_role") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $_$
  SELECT $1 <> $2::text;
$_$;


ALTER FUNCTION "public"."neq_text_user_role"("text", "public"."user_role") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."neq_user_role_text"("public"."user_role", "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $_$
  SELECT $1::text <> $2;
$_$;


ALTER FUNCTION "public"."neq_user_role_text"("public"."user_role", "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" "text", "p_location_ids" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM user_roles
        WHERE user_roles.id = auth.uid() AND user_roles.role IN ('admin', 'steward')
    ) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    DELETE FROM booking_locations WHERE booking_id = p_booking_id;

    INSERT INTO booking_locations (booking_id, location_id)
    SELECT p_booking_id, loc
    FROM unnest(p_location_ids) AS loc
    WHERE loc IS NOT NULL AND trim(loc) <> '';
END;
$$;


ALTER FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" "text", "p_location_ids" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."track_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."track_status_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_performer_total_cost"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  UPDATE performers
  SET total_cost = calculate_performer_total_cost(
    CASE 
      WHEN TG_OP = 'DELETE' THEN OLD.performer_id
      ELSE NEW.performer_id
    END
  )
  WHERE id = CASE 
    WHEN TG_OP = 'DELETE' THEN OLD.performer_id
    ELSE NEW.performer_id
  END;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "public"."update_performer_total_cost"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OPERATOR "public".<> (
    FUNCTION = "public"."neq_text_user_role",
    LEFTARG = "text",
    RIGHTARG = "public"."user_role",
    COMMUTATOR = OPERATOR("public".<>)
);


ALTER OPERATOR "public".<> ("text", "public"."user_role") OWNER TO "postgres";


CREATE OPERATOR "public".<> (
    FUNCTION = "public"."neq_user_role_text",
    LEFTARG = "public"."user_role",
    RIGHTARG = "text",
    COMMUTATOR = OPERATOR("public".<>)
);


ALTER OPERATOR "public".<> ("public"."user_role", "text") OWNER TO "postgres";


CREATE OPERATOR "public".= (
    FUNCTION = "public"."eq_text_user_role",
    LEFTARG = "text",
    RIGHTARG = "public"."user_role",
    COMMUTATOR = OPERATOR("public".=)
);


ALTER OPERATOR "public".= ("text", "public"."user_role") OWNER TO "postgres";


CREATE OPERATOR "public".= (
    FUNCTION = "public"."eq_user_role_text",
    LEFTARG = "public"."user_role",
    RIGHTARG = "text",
    COMMUTATOR = OPERATOR("public".=)
);


ALTER OPERATOR "public".= ("public"."user_role", "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "user_email" "text",
    "user_name" "text",
    "action_type" "text",
    "booking_id" "text",
    "details" "text",
    "instance" "text",
    "action" "text",
    "target_id" "text"
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


ALTER TABLE "public"."audit_logs" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."audit_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."booking_locations" (
    "id" bigint NOT NULL,
    "booking_id" "text" NOT NULL,
    "location_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."booking_locations" OWNER TO "postgres";


ALTER TABLE "public"."booking_locations" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."booking_locations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."bookings" (
    "id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "status" "text" DEFAULT 'Pending'::"text" NOT NULL,
    "admin_notes" "text",
    "rejection_reason" "text",
    "business_name" "text",
    "owner_name" "text",
    "email" "text",
    "phone" "text",
    "address" "text",
    "category" "text",
    "stall_type" "text",
    "location_id" "text",
    "other_requirements" "text",
    "description" "text",
    "documents" "text"[],
    "docs_checklist" "text",
    "date_confirmed" timestamp with time zone,
    "instance_prefix" "text",
    "is_resident" boolean DEFAULT false,
    "registered_business_name" "text",
    "is_charity" "text" DEFAULT 'Commercial'::"text",
    "power_required" "text" DEFAULT 'No power'::"text",
    "cancel_token" "uuid" DEFAULT "gen_random_uuid"(),
    "stall_cost" numeric,
    CONSTRAINT "check_business_len" CHECK (("char_length"("business_name") <= 128)),
    CONSTRAINT "check_desc_len" CHECK (("char_length"("description") <= 1000)),
    CONSTRAINT "check_email_format" CHECK (("email" ~* '^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+[.][A-Za-z]+$'::"text")),
    CONSTRAINT "check_owner_len" CHECK (("char_length"("owner_name") <= 64))
);


ALTER TABLE "public"."bookings" OWNER TO "postgres";


COMMENT ON COLUMN "public"."bookings"."registered_business_name" IS 'Registered business name (if different from trading name/business_name)';



ALTER TABLE "public"."email_queue" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."email_queue_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."email_templates" (
    "id" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body_html" "text" NOT NULL,
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."email_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hcc_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "text",
    "submitted_at" timestamp with time zone DEFAULT "now"(),
    "council_status" "text" DEFAULT 'Pending'::"text",
    "approval_date" "date",
    "updated_by" "text"
);


ALTER TABLE "public"."hcc_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."location_power" (
    "power_available" boolean DEFAULT false NOT NULL,
    "max_capacity" integer,
    "notes" "text",
    "location" "text"
);


ALTER TABLE "public"."location_power" OWNER TO "postgres";


COMMENT ON TABLE "public"."location_power" IS 'Power availability at each performance location';



CREATE TABLE IF NOT EXISTS "public"."locations" (
    "id" "text" NOT NULL,
    "dataset" "text" DEFAULT 'LIVE'::"text" NOT NULL,
    "lat" double precision,
    "lng" double precision,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "has_power" boolean DEFAULT false
);


ALTER TABLE "public"."locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "booking_id" "text" NOT NULL,
    "paid" boolean DEFAULT false,
    "date_paid" "date",
    "bank_ref" "text",
    "editor" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."performers" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "name" "text" NOT NULL,
    "address" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "description" "text" NOT NULL,
    "performance_type" "public"."performance_type" NOT NULL,
    "performance_type_other" "text",
    "cost_per_30min" numeric(10,2) NOT NULL,
    "power_needed" boolean DEFAULT false,
    "insurance_file_url" "text",
    "insurance_file_name" "text",
    "insurance_verified" boolean DEFAULT false,
    "insurance_verified_at" timestamp with time zone,
    "insurance_verified_by" "uuid",
    "status" "public"."performer_status" DEFAULT 'Applied'::"public"."performer_status",
    "status_updated_at" timestamp with time zone DEFAULT "now"(),
    "status_updated_by" "uuid",
    "total_cost" numeric(10,2) DEFAULT 0,
    "amount_paid" numeric(10,2) DEFAULT 0,
    "payment_notes" "text",
    "admin_notes" "text",
    "deleted_at" timestamp with time zone,
    CONSTRAINT "positive_cost" CHECK (("cost_per_30min" >= (0)::numeric)),
    CONSTRAINT "valid_email" CHECK (("email" ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'::"text")),
    CONSTRAINT "valid_phone" CHECK (("phone" ~* '^[0-9\s\+\-\(\)]+$'::"text"))
);


ALTER TABLE "public"."performers" OWNER TO "postgres";


COMMENT ON TABLE "public"."performers" IS 'Street festival performer applications and management';



COMMENT ON COLUMN "public"."performers"."power_needed" IS 'Whether performer requires electrical power';



COMMENT ON COLUMN "public"."performers"."total_cost" IS 'Automatically calculated from scheduled slots';



CREATE OR REPLACE VIEW "public"."public_performer_info" AS
 SELECT "id",
    "name",
    "performance_type",
    "performance_type_other",
    "description",
    "status"
   FROM "public"."performers"
  WHERE (("status" = ANY (ARRAY['Scheduled'::"public"."performer_status", 'Paid'::"public"."performer_status"])) AND ("deleted_at" IS NULL));


ALTER VIEW "public"."public_performer_info" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedules" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "performer_id" "uuid" NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "duration_minutes" integer NOT NULL,
    "event_date" "date" DEFAULT '2026-06-13'::"date" NOT NULL,
    "scheduled_by" "uuid",
    "scheduled_at" timestamp with time zone DEFAULT "now"(),
    "notes" "text",
    "paid_status" "text" DEFAULT 'Pending'::"text",
    "paid_amount" numeric(10,2) DEFAULT 0,
    "paid_at" timestamp with time zone,
    "location" "text" NOT NULL,
    "dataset" "text" NOT NULL,
    CONSTRAINT "schedules_duration_minutes_check" CHECK (("duration_minutes" = ANY (ARRAY[30, 60]))),
    CONSTRAINT "schedules_paid_status_check" CHECK (("paid_status" = ANY (ARRAY['Pending'::"text", 'Paid'::"text"]))),
    CONSTRAINT "valid_duration" CHECK (((EXTRACT(epoch FROM ("end_time" - "start_time")) / (60)::numeric) = ("duration_minutes")::numeric))
);

ALTER TABLE ONLY "public"."schedules" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedules" OWNER TO "postgres";


COMMENT ON TABLE "public"."schedules" IS 'Performance time slots and location assignments';



COMMENT ON COLUMN "public"."schedules"."paid_status" IS 'Payment status for this specific slot';



COMMENT ON COLUMN "public"."schedules"."paid_amount" IS 'Amount paid for this specific slot';



CREATE OR REPLACE VIEW "public"."public_schedule_info" AS
 SELECT "id",
    "performer_id",
    "location",
    "start_time",
    "end_time",
    "duration_minutes",
    "event_date"
   FROM "public"."schedules";


ALTER VIEW "public"."public_schedule_info" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settings" (
    "key" "text" NOT NULL,
    "value" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "updated_by" "text"
);


ALTER TABLE "public"."settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "email" "text",
    CONSTRAINT "user_roles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'steward'::"text"])))
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_locations"
    ADD CONSTRAINT "booking_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_locations"
    ADD CONSTRAINT "booking_locations_unique_pair" UNIQUE ("booking_id", "location_id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_queue"
    ADD CONSTRAINT "email_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_templates"
    ADD CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hcc_checks"
    ADD CONSTRAINT "hcc_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_pkey" PRIMARY KEY ("id", "dataset");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("booking_id");



ALTER TABLE ONLY "public"."performers"
    ADD CONSTRAINT "performers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settings"
    ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_audit_logs_target_id" ON "public"."audit_logs" USING "btree" ("target_id");



CREATE INDEX "idx_booking_locations_booking_id" ON "public"."booking_locations" USING "btree" ("booking_id");



CREATE INDEX "idx_booking_locations_location_id" ON "public"."booking_locations" USING "btree" ("location_id");



CREATE INDEX "idx_bookings_email" ON "public"."bookings" USING "btree" ("email");



CREATE INDEX "idx_bookings_location_id" ON "public"."bookings" USING "btree" ("location_id") WHERE ("location_id" IS NOT NULL);



CREATE INDEX "idx_bookings_status" ON "public"."bookings" USING "btree" ("status");



CREATE INDEX "idx_hcc_checks_booking_id" ON "public"."hcc_checks" USING "btree" ("booking_id");



CREATE INDEX "idx_locations_dataset" ON "public"."locations" USING "btree" ("dataset");



CREATE INDEX "idx_performers_email" ON "public"."performers" USING "btree" ("email") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_performers_status" ON "public"."performers" USING "btree" ("status") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_schedules_location_dataset" ON "public"."schedules" USING "btree" ("location", "dataset");



CREATE INDEX "idx_schedules_paid_status" ON "public"."schedules" USING "btree" ("paid_status");



CREATE INDEX "idx_schedules_performer" ON "public"."schedules" USING "btree" ("performer_id");



CREATE OR REPLACE TRIGGER "track_performer_status_change" BEFORE UPDATE ON "public"."performers" FOR EACH ROW EXECUTE FUNCTION "public"."track_status_change"();



CREATE OR REPLACE TRIGGER "trg_booking_locations_check_conflict" BEFORE INSERT OR UPDATE ON "public"."booking_locations" FOR EACH ROW EXECUTE FUNCTION "public"."booking_locations_check_conflict"();



CREATE OR REPLACE TRIGGER "update_cost_on_schedule_change" AFTER INSERT OR DELETE OR UPDATE ON "public"."schedules" FOR EACH ROW EXECUTE FUNCTION "public"."update_performer_total_cost"();



CREATE OR REPLACE TRIGGER "update_performers_updated_at" BEFORE UPDATE ON "public"."performers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_schedules_updated_at" BEFORE UPDATE ON "public"."schedules" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."booking_locations"
    ADD CONSTRAINT "booking_locations_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hcc_checks"
    ADD CONSTRAINT "hcc_checks_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."performers"
    ADD CONSTRAINT "performers_insurance_verified_by_fkey" FOREIGN KEY ("insurance_verified_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."performers"
    ADD CONSTRAINT "performers_status_updated_by_fkey" FOREIGN KEY ("status_updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_location_fkey" FOREIGN KEY ("location", "dataset") REFERENCES "public"."locations"("id", "dataset");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_performer_id_fkey" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_scheduled_by_fkey" FOREIGN KEY ("scheduled_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



CREATE POLICY "Admin full" ON "public"."bookings" USING ("public"."check_user_role"('admin'::"public"."user_role"));



CREATE POLICY "Admin manage email" ON "public"."email_queue" USING ("public"."check_user_role"('admin'::"public"."user_role"));



CREATE POLICY "Admin manage email_templates" ON "public"."email_templates" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



CREATE POLICY "Admin manage location_power" ON "public"."location_power" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



CREATE POLICY "Admin manage locations" ON "public"."locations" USING ("public"."check_user_role"('admin'::"public"."user_role"));



CREATE POLICY "Admin only payments" ON "public"."payments" USING ("public"."check_user_role"('admin'::"public"."user_role"));



CREATE POLICY "Admin view audit" ON "public"."audit_logs" FOR SELECT USING ("public"."check_user_role"('admin'::"public"."user_role"));



CREATE POLICY "Admins manage hcc_checks" ON "public"."hcc_checks" TO "authenticated" USING ("public"."check_user_role"('admin'::"public"."user_role"));



CREATE POLICY "Allow admins full access to booking_locations" ON "public"."booking_locations" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow admins full access to settings" ON "public"."settings" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



CREATE POLICY "Allow authenticated users to insert audit logs" ON "public"."audit_logs" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Allow public anon to read confirmed booking locations" ON "public"."booking_locations" FOR SELECT TO "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."bookings"
  WHERE (("bookings"."id" = "booking_locations"."booking_id") AND ("bookings"."status" = 'Confirmed'::"text")))));



CREATE POLICY "Allow public anon to read non-sensitive settings" ON "public"."settings" FOR SELECT TO "anon" USING (("key" = ANY (ARRAY['stall_cost_food'::"text", 'stall_cost_general'::"text", 'stall_cost_dev'::"text", 'turnstile_site_key'::"text", 'base_url'::"text", 'cancel_url'::"text", 'portal_url'::"text", 'booking_prefix'::"text", 'bucket_name'::"text", 'hcc_council_email'::"text", 'map_center_lat'::"text", 'map_center_lng'::"text", 'map_default_zoom'::"text"])));



CREATE POLICY "Allow staff to read booking_locations" ON "public"."booking_locations" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = ANY (ARRAY['admin'::"text", 'steward'::"text"]))))));



CREATE POLICY "Applicants can view own" ON "public"."performers" FOR SELECT TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text")));



CREATE POLICY "Auth system log" ON "public"."audit_logs" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Public can apply" ON "public"."performers" FOR INSERT TO "authenticated", "anon" WITH CHECK ((("status" = 'Applied'::"public"."performer_status") AND ("total_cost" = (0)::numeric) AND ("amount_paid" = (0)::numeric) AND ("insurance_verified" = false) AND ("insurance_verified_at" IS NULL) AND ("insurance_verified_by" IS NULL) AND ("status_updated_at" IS NULL) AND ("status_updated_by" IS NULL) AND ("admin_notes" IS NULL) AND ("payment_notes" IS NULL) AND ("deleted_at" IS NULL)));



CREATE POLICY "Public can view scheduled" ON "public"."performers" FOR SELECT TO "authenticated", "anon" USING (("status" = ANY (ARRAY['Scheduled'::"public"."performer_status", 'Paid'::"public"."performer_status"])));



CREATE POLICY "Public row-level access for schedules" ON "public"."schedules" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Public row-level access for views" ON "public"."performers" FOR SELECT TO "anon" USING ((("status" = ANY (ARRAY['Scheduled'::"public"."performer_status", 'Paid'::"public"."performer_status"])) AND ("deleted_at" IS NULL)));



CREATE POLICY "Public see confirmed" ON "public"."bookings" FOR SELECT TO "anon" USING (("status" = 'Confirmed'::"text"));



CREATE POLICY "Public view locations" ON "public"."locations" FOR SELECT USING (true);



CREATE POLICY "Public view power" ON "public"."location_power" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "Steward access" ON "public"."bookings" FOR SELECT USING ("public"."check_user_role"('steward'::"public"."user_role"));



CREATE POLICY "Steward update" ON "public"."bookings" FOR UPDATE USING ("public"."check_user_role"('steward'::"public"."user_role"));



CREATE POLICY "Users can read own role" ON "public"."user_roles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "anon_select_locations" ON "public"."locations" FOR SELECT USING (true);



ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "auth_insert_audit" ON "public"."audit_logs" FOR INSERT TO "authenticated" WITH CHECK (true);



ALTER TABLE "public"."booking_locations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hcc_checks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."location_power" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."locations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "performer_admin_access" ON "public"."performers" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



ALTER TABLE "public"."performers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "policy_allow_all_admin" ON "public"."user_roles" TO "authenticated" USING ("public"."get_is_admin"()) WITH CHECK ("public"."get_is_admin"());



CREATE POLICY "schedule_admin_access" ON "public"."schedules" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."user_roles"
  WHERE (("user_roles"."id" = "auth"."uid"()) AND ("user_roles"."role" = 'admin'::"text")))));



ALTER TABLE "public"."schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."booking_locations_check_conflict"() TO "anon";
GRANT ALL ON FUNCTION "public"."booking_locations_check_conflict"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."booking_locations_check_conflict"() TO "service_role";



GRANT ALL ON FUNCTION "public"."calculate_performer_total_cost"("performer_uuid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."calculate_performer_total_cost"("performer_uuid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."calculate_performer_total_cost"("performer_uuid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."cancel_booking_secure"("p_token" "uuid", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_booking_secure"("p_token" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_booking_secure"("p_token" "uuid", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_user_role"("required_role" "public"."user_role") TO "anon";
GRANT ALL ON FUNCTION "public"."check_user_role"("required_role" "public"."user_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_user_role"("required_role" "public"."user_role") TO "service_role";



GRANT ALL ON TABLE "public"."email_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."email_queue" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_pending_emails"("p_batch_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_pending_emails"("p_batch_size" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."eq_text_user_role"("text", "public"."user_role") TO "anon";
GRANT ALL ON FUNCTION "public"."eq_text_user_role"("text", "public"."user_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."eq_text_user_role"("text", "public"."user_role") TO "service_role";



GRANT ALL ON FUNCTION "public"."eq_user_role_text"("public"."user_role", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."eq_user_role_text"("public"."user_role", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."eq_user_role_text"("public"."user_role", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_next_booking_id"("p_prefix" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_next_booking_id"("p_prefix" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_next_booking_id"("p_prefix" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."neq_text_user_role"("text", "public"."user_role") TO "anon";
GRANT ALL ON FUNCTION "public"."neq_text_user_role"("text", "public"."user_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."neq_text_user_role"("text", "public"."user_role") TO "service_role";



GRANT ALL ON FUNCTION "public"."neq_user_role_text"("public"."user_role", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."neq_user_role_text"("public"."user_role", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."neq_user_role_text"("public"."user_role", "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" "text", "p_location_ids" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" "text", "p_location_ids" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" "text", "p_location_ids" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_set_booking_locations"("p_booking_id" "text", "p_location_ids" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."track_status_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."track_status_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."track_status_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_performer_total_cost"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_performer_total_cost"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_performer_total_cost"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."audit_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."booking_locations" TO "anon";
GRANT ALL ON TABLE "public"."booking_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_locations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."booking_locations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."booking_locations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."booking_locations_id_seq" TO "service_role";



GRANT TRIGGER ON TABLE "public"."bookings" TO "anon";
GRANT ALL ON TABLE "public"."bookings" TO "authenticated";
GRANT ALL ON TABLE "public"."bookings" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."bookings" TO "anon";



GRANT SELECT("business_name") ON TABLE "public"."bookings" TO "anon";



GRANT SELECT("category") ON TABLE "public"."bookings" TO "anon";



GRANT SELECT("stall_type") ON TABLE "public"."bookings" TO "anon";



GRANT SELECT("description") ON TABLE "public"."bookings" TO "anon";



GRANT SELECT("instance_prefix") ON TABLE "public"."bookings" TO "anon";



GRANT ALL ON SEQUENCE "public"."email_queue_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."email_queue_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."email_queue_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."email_templates" TO "anon";
GRANT ALL ON TABLE "public"."email_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."email_templates" TO "service_role";



GRANT ALL ON TABLE "public"."hcc_checks" TO "anon";
GRANT ALL ON TABLE "public"."hcc_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."hcc_checks" TO "service_role";



GRANT ALL ON TABLE "public"."location_power" TO "anon";
GRANT ALL ON TABLE "public"."location_power" TO "authenticated";
GRANT ALL ON TABLE "public"."location_power" TO "service_role";



GRANT ALL ON TABLE "public"."locations" TO "anon";
GRANT ALL ON TABLE "public"."locations" TO "authenticated";
GRANT ALL ON TABLE "public"."locations" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT TRIGGER ON TABLE "public"."performers" TO "anon";
GRANT ALL ON TABLE "public"."performers" TO "authenticated";
GRANT ALL ON TABLE "public"."performers" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."performers" TO "anon";



GRANT SELECT("name"),INSERT("name") ON TABLE "public"."performers" TO "anon";



GRANT INSERT("address") ON TABLE "public"."performers" TO "anon";



GRANT INSERT("email") ON TABLE "public"."performers" TO "anon";



GRANT INSERT("phone") ON TABLE "public"."performers" TO "anon";



GRANT SELECT("description"),INSERT("description") ON TABLE "public"."performers" TO "anon";



GRANT SELECT("performance_type"),INSERT("performance_type") ON TABLE "public"."performers" TO "anon";



GRANT SELECT("performance_type_other"),INSERT("performance_type_other") ON TABLE "public"."performers" TO "anon";



GRANT INSERT("cost_per_30min") ON TABLE "public"."performers" TO "anon";



GRANT INSERT("power_needed") ON TABLE "public"."performers" TO "anon";



GRANT INSERT("insurance_file_url") ON TABLE "public"."performers" TO "anon";



GRANT INSERT("insurance_file_name") ON TABLE "public"."performers" TO "anon";



GRANT SELECT("status") ON TABLE "public"."performers" TO "anon";



GRANT ALL ON TABLE "public"."public_performer_info" TO "anon";
GRANT ALL ON TABLE "public"."public_performer_info" TO "authenticated";
GRANT ALL ON TABLE "public"."public_performer_info" TO "service_role";



GRANT TRIGGER ON TABLE "public"."schedules" TO "anon";
GRANT ALL ON TABLE "public"."schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."schedules" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."schedules" TO "anon";



GRANT SELECT("performer_id") ON TABLE "public"."schedules" TO "anon";



GRANT SELECT("start_time") ON TABLE "public"."schedules" TO "anon";



GRANT SELECT("end_time") ON TABLE "public"."schedules" TO "anon";



GRANT SELECT("duration_minutes") ON TABLE "public"."schedules" TO "anon";



GRANT SELECT("event_date") ON TABLE "public"."schedules" TO "anon";



GRANT ALL ON TABLE "public"."public_schedule_info" TO "anon";
GRANT ALL ON TABLE "public"."public_schedule_info" TO "authenticated";
GRANT ALL ON TABLE "public"."public_schedule_info" TO "service_role";



GRANT ALL ON TABLE "public"."settings" TO "anon";
GRANT ALL ON TABLE "public"."settings" TO "authenticated";
GRANT ALL ON TABLE "public"."settings" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";








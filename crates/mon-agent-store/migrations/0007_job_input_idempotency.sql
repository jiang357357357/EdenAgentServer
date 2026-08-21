CREATE UNIQUE INDEX IF NOT EXISTS session_inputs_job_id_unique
    ON session_inputs(json_extract(payload_json, '$.jobId'))
    WHERE json_extract(payload_json, '$.jobId') IS NOT NULL;

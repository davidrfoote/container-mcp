CREATE OR REPLACE FUNCTION notify_session_events() RETURNS trigger AS
$$ BEGIN
  PERFORM pg_notify('session_events', json_build_object('session_id', NEW.session_id, 'message_type', NEW.message_type)::text);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS session_messages_notify ON session_messages;
CREATE TRIGGER session_messages_notify AFTER INSERT ON session_messages
FOR EACH ROW EXECUTE FUNCTION notify_session_events();

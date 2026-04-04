        case "code_task": {
          if (process.env.CODE_TASK_ENABLED !== "true") {
            return { content: [{ type: "text", text: "code_task is disabled on this container (CODE_TASK_ENABLED not set to true)" }], isError: true };
          }
          const {
            instruction,
            working_dir,
            driver = "claude",
            task_id,
            max_turns = 30,
            budget_usd = 5.0,
            timeout_seconds = 900,
            task_rules,
            base_rules_path = "/home/david/.rules/base.md",
            project_rules_path = "/.rules/project.md",
            session_id,
            ops_db_url,
            model,
            effort,
            agents,
            allowed_tools,
            resume_claude_session_id,
            add_dirs,
          } = args as any;

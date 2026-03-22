use std::fmt;

use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, FormattedFields};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;

struct LambdaFormatter;

impl<S, N> FormatEvent<S, N> for LambdaFormatter
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let level = *event.metadata().level();
        write!(writer, "{level}")?;

        if let Some(scope) = ctx.event_scope() {
            for span in scope.from_root() {
                let ext = span.extensions();
                if let Some(fields) = ext.get::<FormattedFields<N>>() {
                    let s = fields.to_string();
                    if let Some(val) = s.strip_prefix("req=") {
                        write!(writer, " {}", val.trim_matches('"'))?;
                    }
                }
            }
        }

        write!(writer, ": ")?;
        ctx.format_fields(writer.by_ref(), event)?;
        writeln!(writer)
    }
}

pub fn init() {
    tracing_subscriber::fmt()
        .event_format(LambdaFormatter)
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

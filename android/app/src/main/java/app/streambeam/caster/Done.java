package app.streambeam.caster;

/** Result of an asynchronous command sent from the web page. */
interface Done {
    void ok();

    void fail(String error);
}

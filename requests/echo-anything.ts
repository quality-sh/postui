// Saved by postui — this file is the request; edit it freely.
// Values like $NAME resolve from the environment when the request is sent.

export const request = {
  method: "POST",
  url: "https://httpbin.org/anything?source=postui",
  headers: {
    "Content-Type": "application/json",
    "X-Trace": "postui-demo",
  },
  body: "{\"ping\":true}",
};

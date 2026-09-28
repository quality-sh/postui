// Saved by postui — this file is the request; edit it freely.
// Values like $NAME resolve from the environment when the request is sent.

export const request = {
  method: "POST",
  url: "https://jsonplaceholder.typicode.com/posts",
  headers: {
    "Content-Type": "application/json",
  },
  body: "{\"title\":\"hello from postui\",\"body\":\"sent from the terminal\",\"userId\":1}",
};

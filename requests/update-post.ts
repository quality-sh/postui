// Saved by postui — this file is the request; edit it freely.
// Values like $NAME resolve from the environment when the request is sent.

export const request = {
  method: "PUT",
  url: "https://jsonplaceholder.typicode.com/posts/1",
  headers: {
    "Content-Type": "application/json",
  },
  body: "{\"id\":1,\"title\":\"renamed\",\"body\":\"replaced\",\"userId\":1}",
};

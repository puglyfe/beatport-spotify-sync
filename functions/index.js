const functions = require('firebase-functions');
const admin = require('firebase-admin');
const SpotifyWebApi = require('spotify-web-api-node');

admin.initializeApp();

// const scopes = ["playlist-modify-private"];
// const state = "some-state-of-my-choice";

const PLAYLIST_ID = '6WyKo6Zejscls8G676N8UX';

// Create the authorization URL
// const authorizeURL = spotify.createAuthorizeURL(scopes, state);
// console.log("Authorization URL: ", authorizeURL);

const doSpotifyRequest = async (client, req) => {
  console.log('doSpotifyRequest');
  try {
    return req();
  } catch (error) {
    console.log('doSpotifyRequest :: catch', error);
    if (error.code === 401) {
      await refreshAccessToken(client);
      return req();
    }

    return Promise.reject(error);
  }
};

// clientId, clientSecret and refreshToken has been set on the api object previous to this call.
const refreshAccessToken = client => {
  console.log('refreshAccessToken :: ', client);
  return client
    .refreshAccessToken()
    .then(async data => {
      console.log('refreshAccessToken :: success', data.body);
      const { access_token } = data.body;
      // Save the access token so that it's used in future calls
      client.setAccessToken(access_token);

      await admin
        .database()
        .ref('/tokens/access_token')
        .set(access_token);

      return;
    })
    .catch(err => {
      console.log('refreshAccessToken :: error :: ', err);
    });
};

const addTrackToPlaylist = (client, track, playlist = PLAYLIST_ID) => {
  console.log('addTrackToPlaylist :: ', track, playlist);

  return client
    .addTracksToPlaylist(playlist, [track], { position: 0 })
    .then(data => {
      console.log('addTrackToPlaylist :: success :: ', data.body);
      return data.body.snapshot_id;
    })
    .catch(err => {
      console.log('addTrackToPlaylist :: error :: ', err);
      throw err;
    });
};

// "(Original Mix)" is a Beatport thing, and doesn't ever seem to be
// included in Spotify titles. Spotify also uses "-" for remix delimiters
const sanitizeTrackName = name =>
  name.replace(/(Original Mix)/gi, '').replace(/\(\)/g, '');

const searchTrack = async (client, track) => {
  const { Artists, Name } = track;
  const query = `artist:${Artists} track:${sanitizeTrackName(Name)}`;
  console.log('searchTrack :: query :: ', query);

  return client
    .searchTracks(query)
    .then(data => {
      console.log('searchTrack :: success :: ', data.body);
      const { tracks } = data.body;

      if (tracks && tracks.items && tracks.items.length) {
        const firstResult = tracks.items[0];
        return firstResult.uri;
      }

      return null;
    })
    .catch(err => {
      console.log('searchTrack :: error :: ', err);
      return null;
    });
};

/**
 * onRequest - importTracks
 * The root webhook URL for triggering an import
 */
exports.importTracks = functions.https.onRequest(async (req, res) => {
  console.log('importTracks :: ', req.body);
  const { order_id, tracks } = req.body;

  // Format the array as a hash with the track ID as the key.
  const trackCollection = tracks.reduce((acc, track) => {
    const key = track.Item;
    acc[key] = track;
    return acc;
  }, {});

  await admin
    .database()
    .ref('/purchases')
    .child(order_id)
    .set({ tracks: trackCollection });

  // Respond to webhook
  res.send(200);
});

/**
 * onNewPurchase
 * Parse tracks from a purchase and write to /tracks
 */
exports.onNewPurchase = functions.database
  .ref('/purchases/{id}')
  .onCreate(async snapshot => {
    // Iterate over tracks inside a purchase and save to /tracks
    const purchase = snapshot.val();
    await Promise.all(
      Object.keys(purchase.tracks).map(async trackId => {
        const track = purchase.tracks[trackId];
        await admin
          .database()
          .ref('/tracks')
          .child(track.Item)
          .set({ track });
      }),
    );
  });

/**
 * onNewTracks
 * Search for a track on Spotify and save it to a playlist
 */
exports.onNewTracks = functions.database
  .ref('/tracks/{id}')
  .onCreate(async (snapshot, context) => {
    const track = snapshot.val();
    const trackId = context.params.id;

    // Grab the current accessToken from the db
    const accessToken = await admin
      .database()
      .ref('/tokens/access_token')
      .once('value')
      .then(snapshot => snapshot.val());

    // Grab the refreshToken from the db
    const refreshToken = await admin
      .database()
      .ref('/tokens/refresh_token')
      .once('value')
      .then(snapshot => snapshot.val());

    // Initialize the Spotify API client, and then pass it around.
    // This is probably not necessary, but Cloud Functions are annoying sometimes.
    const spotify = new SpotifyWebApi({
      accessToken,
      clientId: functions.config().spotify.client_id,
      clientSecret: functions.config().spotify.client_secret,
      redirectUri:
        'https://beatport-spotify-sync.firebaseapp.com/callback.html',
      refreshToken,
    });

    // TODO: only refresh the access token when necessary.
    await refreshAccessToken(spotify);

    const spotifyUri = await searchTrack(spotify, track.track);

    if (spotifyUri) {
      // Attach the Spotify URI to the track so we can filter out tracks that weren't found.
      await admin
        .database()
        .ref(`/tracks/${trackId}`)
        .update({ spotifyUri });

      const spotifyPlaylistSnapshotId = await addTrackToPlaylist(
        spotify,
        spotifyUri,
      );

      if (spotifyPlaylistSnapshotId) {
        // Add the snapshotId from when the track was added to the playlist.
        // No idea if this will ever be useful.
        await admin
          .database()
          .ref(`/tracks/${trackId}`)
          .update({ spotifyPlaylistSnapshotId });
      }
    }

    console.log('onNewTracks :: complete');
    return;
  });

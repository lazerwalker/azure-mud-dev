import * as SignalR from '@microsoft/signalr'
import { v4 as uuid } from 'uuid'

import axios from 'axios'
import firebase from 'firebase/app'
import 'firebase/auth'
import { Dispatch } from 'react'
import { Badge } from '../server/src/badges'
import { MESSAGE_MAX_LENGTH } from '../server/src/config'
import {
  ErrorResponse,
  RoomResponse,
  ServerSettings
} from '../server/src/types'
import { User } from '../server/src/user'
import {
  Action,
  CaptionMessageAction,
  ChatMessageAction,
  CommandMessageAction,
  ConnectAction,
  DanceAction,
  DeleteMessageAction,
  EmoteAction,
  EquipBadgeAction,
  ErrorAction,
  HideModalAction,
  ModMessageAction,
  NoteAddAction,
  NoteRemoveAction,
  NoteUpdateLikesAction,
  NoteUpdateRoomAction,
  PlayerBannedAction,
  PlayerConnectedAction,
  PlayerDisconnectedAction,
  PlayerEnteredAction,
  PlayerLeftAction,
  PlayerUnbannedAction,
  ReceivedMyProfileAction,
  ReceivedServerSettingsAction,
  SetUnlockedBadgesAction,
  ShoutAction,
  ShowModalAction,
  ShowProfileAction,
  SpaceOpenedOrClosedAction,
  UnlockBadgeAction,
  UpdatedCurrentRoomAction,
  UpdatedPresenceAction,
  UpdatedRoomDataAction,
  UpdateUnlockableBadgesAction,
  UserMapAction,
  WhisperAction
} from './Actions'
import Config from './config'
import { Modal } from './modals'
import { convertServerRoomData, Room } from './room'
import { ThunkDispatch } from './useReducerWithThunk'
import { State } from './reducer'

let myUserId: string
let myDispatch: ThunkDispatch<Action, State>

const inMediaChat: boolean = false

// "Safe" functions (HTTP result not used)
// Can immediately swap these out to use PubSub
// ---------------------------------------

export async function pickUpRandomItemFromList (listName: string) {
  await callAzureFunction('pickUpItem', { list: listName })
}

export async function pickUpItem (item: string) {
  await callAzureFunction('pickUpItem', { item })
}

export async function dropItem () {
  await callAzureFunction('pickUpItem', { drop: true })
}

export async function displayMessage (message: string) {
  await callAzureFunction('displayMessage', { message: message })
}

export async function displayMessageFromList (listName: string) {
  await callAzureFunction('displayMessage', { list: listName })
}

export async function orderNewDrink () {
  await callAzureFunction('orderNewDrink')
}

export async function updateProfileColor (userId: string, color: string) {
  await callAzureFunction('updateProfileColor', {
    userId: userId,
    color: color
  })
}

export async function updateFontReward (userId: string, font: string) {
  await callAzureFunction('updateFontReward', {
    userId: userId,
    font: font
  })
}

export async function disconnect (userId: string) {
  await callAzureFunction('disconnect')
}

export async function deleteRoomNote (noteId: string) {
  await callAzureFunction('deleteRoomNote', { noteId })
}

export async function likeRoomNote (noteId: string) {
  await callAzureFunction('likeRoomNote', { noteId, like: true })
}

export async function unlikeRoomNote (noteId: string) {
  await callAzureFunction('likeRoomNote', { noteId, like: false })
}

export async function addNoteToWall (message: string) {
  if (message !== null && message.length > 0) {
    const id = uuid()
    await callAzureFunction('addRoomNote', { id, message })
  }
}

export async function openOrCloseSpace (spaceIsClosed) {
  await callAzureFunction('openOrCloseSpace', { spaceIsClosed })
}

export async function toggleUserBan (userId: string) {
  await callAzureFunction('banUser', { userId })
}

export async function toggleUserMod (userId: string) {
  await callAzureFunction('toggleModStatus', { userId })
}

export async function toggleUserSpeaker (userId: string, year: string) {
  await callAzureFunction('toggleSpeakerStatus', {
    userId,
    year
  })
}

export async function deleteMessage (messageId: string) {
  await callAzureFunction('deleteMessage', { messageId })
}

export async function deleteRoom (roomId: string): Promise<any> {
  await callAzureFunction('deleteRoom', { roomId })
}

export async function updateRoom (roomId: string, roomData: Room): Promise<any> {
  await callAzureFunction('updateRoom', { roomId, roomData })
}

// "Unsafe" functions using HTTP result.
// We can leave these as-is for now, but they will need refactoring
// in order to switch them over to 100% PubSub
// --------------------------------------------------------------

// HACK WARNING! this is used to resync the presence data after loading
// there's *still* a race condition in that if somebody joins/leaves while the HTTP call is transiting
// then they're invisible and it's not great
// and there's no system of recourse. but! that already existed!
export async function connectRoomData (dispatch: ThunkDispatch<Action, State>) {
  const result: RoomResponse = await callAzureFunction('connect')
  if (result.presenceData) {
    dispatch(UpdatedPresenceAction(result.presenceData))
  }
}

export async function connect (
  userId: string,
  dispatch: ThunkDispatch<Action, State>
) {
  myUserId = userId
  myDispatch = dispatch

  const result: RoomResponse = await callAzureFunction('connect')

  console.log(result)
  dispatch(
    ConnectAction(
      result.roomId,
      convertServerRoomData(result.roomData),
      result.presenceData,
      result.roomNotes
    )
  )
  dispatch(UserMapAction(result.users))

  if (result.profile) {
    dispatch(ReceivedMyProfileAction(result.profile))
  }

  if (result.unlockableBadges) {
    dispatch(UpdateUnlockableBadgesAction(result.unlockableBadges))
  }

  const hubConnection = await connectSignalR(userId, dispatch)
  if (hubConnection.state !== SignalR.HubConnectionState.Connected) {
    throw Error('SignalR connection could not be established!')
  }

  // "serverSettings" is a handled SignalR action
  // So we should just automatically send this down on `connect`
  // (This used to be a separate call, but it's only made right after `connect`)
  const settings: ServerSettings = await callAzureFunctionGet('serverSettings')
  dispatch(ReceivedServerSettingsAction(settings))
}

export async function moveToRoom (roomId: string) {
  const result: RoomResponse | ErrorResponse | any = await callAzureFunction(
    'moveRoom',
    {
      to: roomId
    }
  )

  console.log(result)

  if (result) {
    myDispatch(
      UpdatedCurrentRoomAction(
        result.roomId,
        convertServerRoomData(result.roomData)
      )
    )

    if (result.roomNotes) {
      myDispatch(NoteUpdateRoomAction(result.roomId, result.roomNotes))
    }
  }
}

export async function sendChatMessage (id: string, text: string) {
  // If it's over the character limit
  if (text.length > MESSAGE_MAX_LENGTH) {
    console.log(
      `Sorry, can't send messages over ${MESSAGE_MAX_LENGTH} characters!`
    )
    return
  }

  const result: RoomResponse | Error | any = await callAzureFunction(
    'sendChatMessage',
    {
      id: id,
      text: text
    }
  )

  console.log(result)

  // If it's a /move command
  if (result && result.roomId) {
    myDispatch(
      UpdatedCurrentRoomAction(
        result.roomId,
        convertServerRoomData(result.roomData)
      )
    )
  } else if (result && result.user) {
    myDispatch(ShowProfileAction(result.user))
  } else if (result && result.error) {
    myDispatch(ErrorAction(result.error))
  }
}

export async function sendCaption (id: string, text: string) {
  // TODO: This may or may not be problematic
  if (text.length > MESSAGE_MAX_LENGTH) {
    console.log(
      `Sorry, can't send messages over ${MESSAGE_MAX_LENGTH} characters!`
    )
    return
  }

  const result: RoomResponse | Error | any = await callAzureFunction(
    'sendCaption',
    {
      id: id,
      text: text
    }
  )

  console.log(result)

  if (result && result.error) {
    myDispatch(ErrorAction(result.error))
  }
}

export async function fetchProfile (userId: string) {
  const result = await callAzureFunction('fetchProfile', { userId })
  if (result.error) {
    console.log('Could not fetch profile', result.erroc)
  } else {
    myDispatch(ShowProfileAction(result.user))
  }
}

export async function resetRoomData () {
  const response = await callAzureFunction('resetRoomData')
  if (response.roomData) {
    myDispatch(UpdatedRoomDataAction(convertServerRoomData(response.roomData)))
  }
}

export async function resetBadgeData () {
  const response = await callAzureFunction('resetBadgeData')

  if (response.unlockedBadges) {
    myDispatch(SetUnlockedBadgesAction(response.unlockedBadges))
  }

  // This is janky, but this is debug funcitonality, so shrug
  if (response.equippedBadges && response.equippedBadges.length === 0) {
    myDispatch(EquipBadgeAction(undefined, 0))
    myDispatch(EquipBadgeAction(undefined, 1))
  }
}

export async function equipBadge (badge: Badge, index: number) {
  const result = await callAzureFunction('equipBadge', { badge, index })
  if (!result || !result.badges) {
    console.log('ERROR: Server did not return badges from an equipBadge call')
    return
  }
  console.log(result.badges)
  for (let i = 0; i < result.badges.length; i++) {
    myDispatch(EquipBadgeAction(result.badges[i], i))
  }
}

export async function checkIsRegistered (): Promise<{
  registeredUsername: string;
  spaceIsClosed: boolean;
  isMod: string;
  isBanned: boolean;
}> {
  const result = await callAzureFunction('isRegistered')
  return {
    registeredUsername: result.registered,
    spaceIsClosed: result.spaceIsClosed,
    isMod: result.isMod,
    isBanned: result.isBanned
  }
}

// These 3 functions are only used by admin.
export async function getRoomIds (): Promise<string[]> {
  const result = await callAzureFunction('getRoomIds')
  if (result.roomIds) {
    return result.roomIds
  }
}

export async function getRoom (roomId: string): Promise<Room> {
  const result = await callAzureFunction('getRoom', { roomId })
  if (result.room) {
    return result.room
  }
}

export async function getAllRooms (): Promise<{ [roomId: string]: Room }> {
  const result = await callAzureFunction('getAllRooms')
  if (result.roomData) {
    return result.roomData
  }
}

// "Real" HTTP Functions
// used just as an HTTP request, do not refactor to WS
// ---------------------------------------------------------------
export async function fetchTwilioToken () {
  return await callAzureFunction('twilioToken')
}

export async function fetchCognitiveServicesKey () {
  return await callAzureFunction('cognitiveServicesKey')
}

// If isNewUser is true, a successful update will refresh the entire page instead of dismissing a modal
export async function updateProfile (user: Partial<User>, isNew: boolean) {
  const result = await callAzureFunction('updateProfile', { user, isNew })
  if (result.valid) {
    if (isNew) {
      window.location.reload()
    } else {
      myDispatch(ReceivedMyProfileAction(result.user))
      myDispatch(HideModalAction())
    }
  } else if (result.error) {
    alert(result.error)
  }
}

// These are only for admins
export async function updateServerSettings (serverSettings: ServerSettings) {
  const result = await callAzureFunction('serverSettings', serverSettings)
  if (result) {
    myDispatch(HideModalAction())
  }
}

// Setup

const eventMapping = (userId: string, dispatch: Dispatch<Action>) => {
  return {
    playerConnected: (user) => {
      console.log('Player joined!', user)
      dispatch(PlayerConnectedAction(user))
    },
    playerDisconnected: (otherId) => {
      console.log('Player left!', otherId)
      dispatch(PlayerDisconnectedAction(otherId))
    },
    presenceData: (data) => {
      dispatch(UpdatedPresenceAction(data))
    },
    chatMessage: (messageId, otherId, message) => {
      // We use otherId/name basically interchangably here.
      console.log('Received chat', otherId, message)
      console.log(otherId, message, userId)
      if (otherId === userId) return

      dispatch(ChatMessageAction(messageId, otherId, message))
    },
    caption: (messageId, otherId, message) => {
      console.log('Received caption', otherId, message)
      console.log(otherId, message, userId)
      if (otherId === userId) return

      dispatch(CaptionMessageAction(messageId, otherId, message))
    },
    mods: (otherId, message) => {
      dispatch(ModMessageAction(otherId, message))
    },
    deleteMessage: (modId, targetMessageId) => {
      dispatch(DeleteMessageAction(modId, targetMessageId))
    },
    playerEntered: (name, fromId, fromName) => {
      if (name === userId) return
      dispatch(PlayerEnteredAction(name, fromId, fromName))
    },
    myProfile: (profile) => {
      dispatch(ReceivedMyProfileAction(profile))
    },
    serverSettings: (serverSettings) => {
      dispatch(ReceivedServerSettingsAction(serverSettings))
    },
    whisper: (otherId, message) => {
      dispatch(WhisperAction(otherId, message))
    },
    privateCommand: (message) => {
      dispatch(CommandMessageAction(message))
    },
    privateItemPickup: (message) => {
      dispatch(CommandMessageAction(message))
    },
    playerLeft: (name, toId, toName) => {
      if (name === userId) return
      dispatch(PlayerLeftAction(name, toId, toName))
    },
    usernameMap: (map) => {
      console.log('Received map', map)
      dispatch(UserMapAction(map))
    },
    playerBanned: (user) => {
      dispatch(PlayerBannedAction(user))
    },
    playerUnbanned: (user) => {
      dispatch(PlayerUnbannedAction(user))
    },
    clientDeployed: () => {
      dispatch(ShowModalAction(Modal.ClientDeployed))
    },
    shout: (messageId, name, message) => {
      // We don't gate on your own userId here.
      // Because shouting can fail at the server level, we don't show it preemptively.
      dispatch(ShoutAction(messageId, name, message))
    },
    emote: (messageId, name, message) => {
      dispatch(EmoteAction(messageId, name, message))
    },
    dance: (messageId, name, message) => {
      dispatch(DanceAction(messageId, name, message))
    },
    noteAdded: (roomId, noteId, message, authorId) => {
      // Post-It Note Wall
      dispatch(NoteAddAction(roomId, { id: noteId, message, authorId }))
    },
    noteRemoved: (roomId, noteId) => {
      dispatch(NoteRemoveAction(roomId, noteId))
    },
    noteLikesUpdated: (roomId, noteId, likes) => {
      dispatch(NoteUpdateLikesAction(roomId, noteId, likes))
    },
    spaceOpenedOrClosed: (status) => {
      dispatch(SpaceOpenedOrClosedAction(status))
    },
    ping: () => {
      console.log('Received heartbeat ping')
      callAzureFunction('pong')
    },
    unlockBadge: (badge) => {
      if (badge.length !== 1) {
        console.log(
          'ERROR: Expected one badge to unlock, got multiple:',
          badge
        )
      }
      dispatch(UnlockBadgeAction(badge[0]))
    }
  }
}

export async function connectPubSub () {
  /*
  const firebaseToken = await firebase.auth().currentUser.getIdToken(false)
      request.headers = {
        ...request.headers,
        userid: firebase.auth().currentUser.uid
      }
  */
  // negotiate
  const result = await callAzureFunctionGet('negotiate')
  if (!result.url) {
    console.error('Did not get URL', result)
    return
  }

  // connect
  const ws = new WebSocket(result.url)
  // TODO: Handle error and close
  ws.addEventListener('open', () => {
    console.log('Conneted to PubSub Service')
    // Note status
  })
  ws.addEventListener('message', (event) => {
    const message = event.data
  })
  // ws.send(message);
}

export async function connectSignalR (
  userId: string,
  dispatch: Dispatch<Action>
): Promise<SignalR.HubConnection> {
  class CustomHttpClient extends SignalR.DefaultHttpClient {
    public async send (
      request: SignalR.HttpRequest
    ): Promise<SignalR.HttpResponse> {
      const firebaseToken = await firebase.auth().currentUser.getIdToken(false)
      request.headers = {
        ...request.headers,
        userid: firebase.auth().currentUser.uid
      }
      return super.send(request)
    }
  }

  const connection = new SignalR.HubConnectionBuilder()
    .withUrl(`${Config.SERVER_HOSTNAME}/api`, {
      httpClient: new CustomHttpClient(console)
    })
    .configureLogging(SignalR.LogLevel.Debug)
    .build()

  const mapping = eventMapping(userId, dispatch)

  Object.keys(mapping).forEach((eventName) => {
    connection.on(eventName, eventMapping[eventName])
  })

  connection.onclose(() => {
    console.log('disconnected')
    // This is called when the connection dies horribly.
    // Chances are that if this happens we *can't* actually talk to the server, so the following function will fail
    // most of the time. The disconnect modal will then enter a reconnect loop with backoff.
    callAzureFunction('disconnect')
    dispatch(ShowModalAction(Modal.Disconnected))
  })

  window.addEventListener('beforeunload', (e) => {
    callAzureFunction('disconnect')
  })

  console.log('connecting...')
  await connection
    .start()
    .then(() => {
      console.log('Connected!')
    })
    .catch(console.error)
  return connection
}

async function callAzureFunctionGet (endpoint: string): Promise<any> {
  try {
    const firebaseToken = await firebase.auth().currentUser.getIdToken(false)
    const r = await axios.get(`${Config.SERVER_HOSTNAME}/api/${endpoint}`, {
      withCredentials: true,
      headers: {
        Authorization: `Bearer ${firebaseToken}`
      }
    })
    console.log(r)
    return r.data
  } catch (e) {
    console.log('Error', e)
    return undefined
  }
}

async function callAzureFunction (endpoint: string, body?: any): Promise<any> {
  try {
    const firebaseToken = await firebase.auth().currentUser.getIdToken(false)
    const r = await axios.post(
      `${Config.SERVER_HOSTNAME}/api/${endpoint}`,
      body,
      {
        withCredentials: true,
        headers: {
          Authorization: `Bearer ${firebaseToken}`
        }
      }
    )
    console.log(r)
    return r.data
  } catch (e) {
    console.log('Error', e)
    return undefined
  }
}

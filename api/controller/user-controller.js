/*
User
u_id
u_name
u_email
u_hash
u_reset_password_token
u_reset_expiration
*/

const promisify = require('es6-promisify');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const crypto = require('crypto');
const nodemail = require('nodemailer');
const handlebars = require('handlebars');
const blacklist = require('express-jwt-blacklist');
const {User, hashPassword, verifyPassword, generateJWT} = require('../model/user-model');

passport.use(new LocalStrategy({
    usernameField: 'username',
    passwordField: 'password',
    passReqToCallback: false,
    session: false
  }, (username, password, done) => {
    User.findOne({where: {u_name: username}}).then(user => {
      if (!user) return done(null, false); // no user
      return verifyPassword(password, user.u_hash)
        .then(response => {
          if (response) { // password ok
            return done(null, user); // user
          }
          return done(null, false); // password ko
        }).catch(error => done(error));
    }).catch(error => done(error));
  }
));

function register(req, res) {
  const {password} = req.body;

  hashPassword(password)
    .then(hash => saveUserInDb(req, res, hash))
    .catch(error => res.status(500).json({error}));
}

function saveUserInDb(req, res, hash) {
  const {username, mail} = req.body;
  // .spread(user, created) = .then([user, created])
  User.findOrCreate({where: {u_name: username}, defaults: {u_email: mail, u_hash: hash}}).spread((user, created) => {
    if (!created) { // existe déjà
      return res.status(400).json({error: `le nom d'utilisateur ${user.u_name} est déjà utilisé.`});
    }
    res.status(200).json({success: 'Utilisateur créé avec succès !'});
    //return res.redirect('/');
  }).catch(error => {
    return res.status(500).send({error});
  });
}

function login(req, res) {
  const {username, password} = req.body;

  // NOTE
  // passport.authenticate does not support promisify
  // you have to pass req, res to this method
  passport.authenticate('local',
    {successRedirect: '/', failureRedirect: '/login'}, (error, user) => {
    if (error) {
      return res.status(500).json({error});
    }

    if (!user) {
      return res.status(404).json({error: `utilisateur (${username}) non trouvé.`});
    }

    const token = generateJWT(user);
    res.status(200).json({token});
    //return res.redirect('/');
  })(req, res);
}

function getResetToken(req, res) {
  const {mail} = req.body;
  // récupération de l'utilisateur
  User.find({wbere: {u_email: mail}}).then(user => {
    if (!user) {
      res.status(404).json({error: "Cette e-mail n'appartient à aucun compte utilisateur."});
      return;
    }

    // ajout du token + date d'expiration à son compte
    const token = crypto.randomBytes(20).toString('hex');
    user.update({
      u_reset_password_token: token,
      u_reset_expiration: Date.now() + 3600
    }).then(([rowAffected]) => {
      // envoi du mail avec le id utilisateur + token
      // title, content, url, action
      const id = user.u_id;
      const options = {
        title: 'Réinitialisation du mot de passe',
        content: `Vous recevez ce mail car vous avec perdu votre mot de passe,
          cliquez sur le lien ci-dessous pour changer de mot de passe`,
        url: `http://${req.hostname}/api/account/reset?id=${id}&token=${token}`,
        action: 'Changer de mot de passe'
      };

      sendMail(mail, options).then(info => {
        console.log('sendMail sent');
        res.status(200).json({success: `Email envoyé avec succès à ${mail}. Vous avez 1 heure.`});
      }).catch(error => res.status(500).json({error}));
    }).catch(error => res.status(500).json({error}));
  }).catch(error => res.status(500).json({error}));
}

function sendMail(mail, options) {
  const transporter = nodemail.createTransport({
    host: production ? process.env.HOSTMAIL : 'localhost',
    port: production ? 465 : 1025,
    secure: production ? true : false,
    auth: production ? {
      user: process.env.USERMAIL,
      pass: process.env.PASSMAIL
    } : false
  });

  const emailHtml = handlebars.compile('../templates/email.hbs')(options);

  const mailOptions = {
    from: 'WebGames <admin@webgames.com>',
    to: mail,
    subject: options.title,
    html: emailHtml
  };

  console.log('email');

  return promisify(transporter.sendMail, transporter)(mailOptions);
}

function resetPasswordForm(req, res) {
  const {id, token} = req.query;
  User.findById(id).then(user => {
    if (!user) {
      res.status(404).json({error: 'utilisateur non trouvé... Hack ?'});
      return;
    }

    if (user.u_reset_expiration < Date.now()) {
      res.status(400).json({error: 'Token de réinitialisation de mot de passe expiré'});
      return;
    }

    if (token !== user.u_reset_password_token) {
      res.status(400).json({error: 'Token de réinitialisation de mot de passe invalide'});
      return;
    }

    // res.redirect,...
  }).catch(error => {
    res.status(500).json({error});
  });
}

function resetPassword(req, res) {
  const {mail, password} = req.body;

  User.find({wbere: {u_email: mail}}).then(user => {
    if (!user) {
      res.status(404).json({error: "Cette e-mail n'appartient à aucun compte utilisateur."});
      return;
    }

    hashPassword(password)
    .then(hash => {
      user.updateAttributes({
        u_hash: hash
      }).then(update => {
        res.status(200).json({success: 'mot de passe changé avec succès !'});
      }).catch(error => {
        res.status(500).json({error});
      });
    });
  }).catch(error => {
    res.status(500).json({error});
  });
}

function getAccount(req, res) {
  const {id} = req.params;
  User.findById(id).then(user => {
    res.status(200).json(user);
  }).catch(error => {
    res.status(500).json({error});
  });
}

function getCurrentAccount(req, res) {
  const simpleUserJson = {
    username: req.user.username,
    mail: req.user.mail
  }
  res.status(200).json(simpleUserJson);
}

function updateAccount(req, res) {
  User.update(req.body, {where: {u_id: req.user._id}}).then(([rowAffected]) => {
    // get updated profile
    User.findById(req.user._id).then(user => {
      const token = generateJWT(user);
      revokeToken(req.user).then(_ => res.status(200).json({token}));
    }).catch(res.status(500).send({error}));
  }).catch(error => res.status(500).send({error}));
}

function revokeToken(user) {
  return new Promise(r => blacklist.revoke(user, r));
}

function logout(req, res) {
  revokeToken(req.user)
    .then(_ => res.status(200).send('disconnected').redirect('/'));
}

module.exports = {
  register,
  login,
  resetPasswordForm,
  resetPassword,
  getResetToken,
  getAccount,
  getCurrentAccount,
  updateAccount,
  logout
}
